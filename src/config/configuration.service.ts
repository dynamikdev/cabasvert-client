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

import { HttpClient } from "@angular/common/http"
import { Injectable } from "@angular/core"
import { of } from "rxjs/observable/of"
import { catchError, take, tap } from "rxjs/operators"

import { Configuration, defaultConfiguration, environment } from "./configuration"

@Injectable()
export class ConfigurationService {

  private configData: Configuration

  constructor(private http: HttpClient) {
  }

  async loadConfiguration() {
    console.log('Loading configuration...')

    let nodeEnv = environment().node
    let fromFile = await this.http.get<Configuration>(`config.${nodeEnv}.json`)
      .pipe(
        take(1),
        tap({
          error: error => {
            console.error(`Error while loading configuration file: ${error.message}`)
          },
        }),
        catchError(() => of({})),
      )
      .toPromise()

    let defaults = defaultConfiguration()

    this.configData = this.merge(this.merge({}, defaults), fromFile)

    console.log(`Loaded configuration: ${JSON.stringify(this.configData)}`)
  }

  private merge(target, source) {
    for (let i in source) {
      if (source.hasOwnProperty(i)) {
        if (typeof source[i] == "object" && source[i] !== null) {
          target[i] = this.merge(target[i] || {}, source[i])
        } else {
          target[i] = source[i]
        }
      }
    }
    return target
  }

  get base() {
    return this.configData.base
  }

  get log() {
    return this.configData.log
  }
}
