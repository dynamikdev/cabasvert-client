/*
 * This file is part of CabasVert.
 *
 * Copyright 2017, 2018 Didier Villevalois
 *
 * CabasVert is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * CabasVert is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with CabasVert.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Injectable, OnDestroy, OnInit } from "@angular/core"
import { Network } from "@ionic-native/network"
import { Platform } from "ionic-angular"

import { BehaviorSubject } from "rxjs/BehaviorSubject"
import { Observable } from "rxjs/Observable"
import { combineLatest } from "rxjs/observable/combineLatest"
import { defer } from "rxjs/observable/defer"
import { empty } from "rxjs/observable/empty"
import { fromPromise } from "rxjs/observable/fromPromise"
import { merge } from "rxjs/observable/merge"
import { of } from "rxjs/observable/of"
import { _throw } from "rxjs/observable/throw"
import {
  catchError, delay, filter, map, mapTo, publishReplay, refCount, retryWhen, startWith,
  switchAll, switchMap, switchMapTo, take, withLatestFrom,
} from "rxjs/operators"
import { Subject } from "rxjs/Subject"
import { Subscription } from "rxjs/Subscription"

import { ConfigurationService } from "../../config/configuration.service"

import { filterNotNull, previous } from "../../utils/observables"
import { SyncState } from "../components/sync-state-listener"
import { AuthService } from "./auth-service"
import { Database, DatabaseHelper } from "./database-helper"

enum NetworkState {
  OFFLINE,
  ONLINE,
  DISCONNECTED,
  RECONNECTED,
}

@Injectable()
export class DatabaseService implements OnDestroy {

  private _forceRecreateIfNecessary$ = new Subject<void>()

  private _database$: Observable<Database | null>
  private _syncState$: Observable<SyncState | null>

  private _subscription: Subscription = new Subscription()

  constructor(private config: ConfigurationService,
              private dbHelper: DatabaseHelper,
              private authService: AuthService,
              private platform: Platform,
              private network: Network) {
  }

  initialize() {
    let loggedInUser$ = this.authService.loggedInUser$
    let loggedIn$ = loggedInUser$.pipe(map(user => !!user))

    let network$: Observable<NetworkState> =
      fromPromise(this.platform.ready()).pipe(
        switchMap(() =>
          merge(
            this.network.onConnect().pipe(mapTo(NetworkState.RECONNECTED)),
            this.network.onDisconnect().pipe(mapTo(NetworkState.DISCONNECTED)),
          ).pipe(
            startWith(this.network.type != 'none' ? NetworkState.ONLINE : NetworkState.OFFLINE),
          ),
        ),
        catchError(error => of(NetworkState.ONLINE)),
        publishReplay(1),
        refCount(),
      )
    let networkUp$ = network$.pipe(
      map(status => status == NetworkState.ONLINE || status == NetworkState.RECONNECTED),
    )

    let localDb$: Observable<Database> = loggedIn$.pipe(
      withLatestFrom(loggedInUser$, (loggedIn, user) => {
        if (!loggedIn) return of(null)

        let dbName = `cabasvert-${user.username}`
        return this.createLocalDatabase$(dbName)
      }),
      switchAll(),
      publishReplay(1),
      refCount(),
    )

    this._subscription.add(
      localDb$.pipe(
        previous(),
        filterNotNull(),
        switchMap(db => DatabaseService.closeDatabase$(db)),
      ).subscribe(),
    )

    let forceRecreateRemote$: Subject<void> = new BehaviorSubject(null)

    let remoteDbNeeded$ = combineLatest(
      loggedIn$, networkUp$, forceRecreateRemote$,
      (loggedIn, networkUp, forceRecreate) => loggedIn && networkUp,
    )
    let remoteDb$: Observable<Database> = remoteDbNeeded$.pipe(
      withLatestFrom(network$, (needed, status) => {
        if (!needed) return of(null)

        let dbName = 'cabasvert'
        let creation = this.createRemoteDatabase$(dbName)

        // Delay and make multiple attempts to login to remote database
        // in case of reconnection as the network might not be fully operable
        let initialDelay = status == NetworkState.RECONNECTED ? 500 : 0
        return creation.pipe(
          delay(initialDelay),
          switchMap(db =>
            defer(() => this.loginDatabase$(db)).pipe(
              retryWhen(errors => errors.pipe(delay(500), take(10))),
            ),
          ),
        )
      }),
      switchAll(),
      publishReplay(1),
      refCount(),
    )

    this._subscription.add(
      remoteDb$.pipe(
        previous(),
        filterNotNull(),
        // Do not try to logout database as cookie is shared
        switchMap(db => DatabaseService.closeDatabase$(db)),
      ).subscribe,
    )

    this._subscription.add(
      merge(this.platform.resume, this._forceRecreateIfNecessary$).pipe(
        withLatestFrom(
          remoteDb$.pipe(filterNotNull()),
          (_, db) => fromPromise(db.getSession()).pipe(
            map(response => !response.ok || !response.userCtx.name),
            catchError(error => of(true)),
          ),
        ),
        switchAll(),
        filter(forceRecreate => forceRecreate),
        mapTo(null),
      ).subscribe(forceRecreateRemote$),
    )

    let maintainSync$ = combineLatest(localDb$, remoteDb$, (localDB, remoteDB) => {
      if (localDB) {
        DatabaseService.cancelSync(localDB)
      }
      if (localDB && remoteDB) {
        DatabaseService.setupSync(localDB, remoteDB)
      }
    })
    this._subscription.add(
      maintainSync$.subscribe(),
    )

    this._database$ = this.config.base.remoteDBOnly ? remoteDb$ : localDb$
    this._syncState$ = this._database$.pipe(
      switchMap(d => d ? d.syncState$ : of(null)),
    )
  }

  ngOnDestroy() {
    this._subscription.unsubscribe()
  }

  get database$(): Observable<Database | any> {
    return this._database$.pipe(filterNotNull())
  }

  public withIndex$(index: any): Observable<Database | any> {
    if (this.config.base.remoteDBOnly) return this.database$
    return this.database$.pipe(
      switchMap(db => fromPromise(db.withIndex(index))),
    )
  }

  get syncState$(): Observable<SyncState | null> {
    return this._syncState$
  }

  get forceRecreateIfNecessary$(): Subject<void> {
    return this._forceRecreateIfNecessary$
  }

  private createLocalDatabase$(dbName: string): Observable<Database> {
    return defer(() =>
      fromPromise(
        this.maybeWipeLocalDB(dbName).then(() =>
          this.dbHelper.newLocalDatabase(dbName),
        ),
      ),
    )
  }

  private maybeWipeLocalDB(dbName: string): Promise<void> {
    if (this.config.base.wipeLocalDB) {
      let tempDB = this.dbHelper.newLocalDatabase(dbName)
      console.log("For debugging purposes, wiping local database !")
      return tempDB.destroy()
    } else return Promise.resolve()
  }

  private createRemoteDatabase$(dbName: string): Observable<Database> {
    return defer(() =>
      of(this.dbHelper.newRemoteDatabase(dbName)),
    )
  }

  private loginDatabase$(db: Database): Observable<Database> {
    return fromPromise(this.authService.loginDatabase(db)).pipe(
      switchMap(ok => ok ? of(db) : _throw("Can't login database")),
    )
  }

  private logoutDatabase$(db: Database): Observable<never> {
    return fromPromise(this.authService.logoutDatabase(db)).pipe(
      switchMapTo(empty()),
    )
  }

  private static closeDatabase$(db: Database): Observable<never> {
    return fromPromise(db.close()).pipe(
      switchMapTo(empty()),
    )
  }

  private static setupSync(localDatabase: Database, remoteDatabase: Database) {
    localDatabase.doSync(remoteDatabase, {
      live: true,
      retry: true,
      continuous: true,
      push: {
        filter: function (doc) {
          return !doc._id.startsWith("_design/")
        },
      },
    })
  }

  private static cancelSync(localDB: Database) {
    localDB.doCancelSync()
  }
}
