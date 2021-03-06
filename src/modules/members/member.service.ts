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

import { Injectable } from '@angular/core'
import { Observable } from "rxjs/Observable"
import { map, publishReplay, refCount, switchMap } from "rxjs/operators"

import { DatabaseService } from "../../toolkit/providers/database-service"
import '../../utils/dates'
import { SeasonWeek } from "../seasons/season.model"
import { Member, TrialBasket } from "./member.model"

@Injectable()
export class MemberService {

  private members$: Observable<Member[]>
  private membersIndexed$: Observable<{ [id: string]: Member }>

  constructor(private mainDatabase: DatabaseService) {
  }

  getMembers$(): Observable<Member[]> {
    if (this.members$ != null) return this.members$

    let query = {
      selector: {
        type: 'member'
      }
    }

    let db$ = this.mainDatabase.withIndex$({
      index: {
        fields: ['type']
      }
    })
    this.members$ = db$.pipe(
      switchMap(db => db.findAll$(query)),
      map(ms => (ms as Member[])),
      publishReplay(1),
      refCount(),
    )

    return this.members$
  }

  getMembersIndexed$(): Observable<{ [id: string]: Member }> {
    if (this.membersIndexed$ != null) return this.membersIndexed$

    // TODO Make more optimal by using changes directly and not mapping the result of findAll
    this.membersIndexed$ = this.getMembers$().pipe(
      map(
        ms => ms.reduce(
          (acc, m) => {
            acc[m._id] = m
            return acc
          },
          {}
        )
      ),
      publishReplay(1),
      refCount(),
    )

    return this.membersIndexed$
  }

  getMember$(lastname: string, firstname: string): Observable<Member> {
    return this.members$.pipe(map(ms =>
      ms.find(m =>
        m.persons.some(p => p.firstname == firstname && p.lastname == lastname)
      )
    ))
  }

  withChanges$(member$: Observable<Member>): Observable<Member> {
    return this.mainDatabase.database$.pipe(switchMap(db => db.withChanges$(member$)))
  }

  putMember$(member: Member): Observable<string> {
    return this.mainDatabase.database$.pipe(switchMap(db => db.put$(member)))
  }

  // TODO Move these methods to Member class when it becomes one

  static memberHasTrialBasketForWeek(member: Member, week: SeasonWeek): boolean {
    return member.trialBaskets && member.trialBaskets.some(b =>
      b.season == week.season.id && b.week == week.seasonWeek
    )
  }

  static memberGetTrialBasketForWeek(member: Member, week: SeasonWeek): TrialBasket {
    return member.trialBaskets.find(b =>
      b.season == week.season.id && b.week == week.seasonWeek
    )
  }
}
