/**
 * @module @ember-data/store
 */
import { assert, deprecate, warn } from '@ember/debug';
import { _backburner as emberBackburner } from '@ember/runloop';
import { DEBUG } from '@glimmer/env';

import { default as RSVP, resolve } from 'rsvp';

import { DEPRECATE_RSVP_PROMISE } from '@ember-data/private-build-infra/deprecations';
import type { CollectionResourceDocument, SingleResourceDocument } from '@ember-data/types/q/ember-data-json-api';
import type { FindRecordQuery, Request, SaveRecordMutation } from '@ember-data/types/q/fetch-manager';
import type {
  RecordIdentifier,
  StableExistingRecordIdentifier,
  StableRecordIdentifier,
} from '@ember-data/types/q/identifier';
import type { MinimumSerializerInterface } from '@ember-data/types/q/minimum-serializer-interface';
import type { FindOptions } from '@ember-data/types/q/store';
import type { Dict } from '@ember-data/types/q/utils';

import ShimModelClass from '../legacy-model-support/shim-model-class';
import type Store from '../store-service';
import coerceId from '../utils/coerce-id';
import { _bind, _guard, _objectIsAlive, guardDestroyedStore } from '../utils/common';
import { normalizeResponseHelper } from '../utils/serializer-response';
import WeakCache from '../utils/weak-cache';
import RequestCache from './request-cache';
import Snapshot from './snapshot';

function payloadIsNotBlank(adapterPayload): boolean {
  if (Array.isArray(adapterPayload)) {
    return true;
  } else {
    return Object.keys(adapterPayload || {}).length !== 0;
  }
}

type AdapterErrors = Error & { errors?: string[]; isAdapterError?: true };
type SerializerWithParseErrors = MinimumSerializerInterface & {
  extractErrors?(store: Store, modelClass: ShimModelClass, error: AdapterErrors, recordId: string | null): any;
};

export const SaveOp: unique symbol = Symbol('SaveOp');

export type FetchMutationOptions = FindOptions & { [SaveOp]: 'createRecord' | 'deleteRecord' | 'updateRecord' };

interface PendingFetchItem {
  identifier: StableExistingRecordIdentifier;
  queryRequest: Request;
  resolver: RSVP.Deferred<any>;
  options: FindOptions;
  trace?: any;
  promise: Promise<StableRecordIdentifier>;
}

interface PendingSaveItem {
  resolver: RSVP.Deferred<any>;
  snapshot: Snapshot;
  identifier: RecordIdentifier;
  options: FetchMutationOptions;
  queryRequest: Request;
}

/**
 * Manages the state of network requests initiated by the store
 *
 * @class FetchManager
 * @private
 */
export default class FetchManager {
  declare isDestroyed: boolean;
  declare requestCache: RequestCache;
  // saves which are pending in the runloop
  declare _pendingSave: PendingSaveItem[];
  // fetches pending in the runloop, waiting to be coalesced
  declare _pendingFetch: Map<string, PendingFetchItem[]>;

  constructor(private _store: Store) {
    // used to keep track of all the find requests that need to be coalesced
    this._pendingFetch = new Map();
    this._pendingSave = [];
    this.requestCache = new RequestCache();
    this.isDestroyed = false;
  }

  clearEntries(identifier: StableRecordIdentifier) {
    delete this.requestCache._done[identifier.lid];
  }

  /**
    This method is called by `record.save`, and gets passed a
    resolver for the promise that `record.save` returns.

    It schedules saving to happen at the end of the run loop.

    @internal
  */
  scheduleSave(identifier: RecordIdentifier, options: FetchMutationOptions): Promise<null | SingleResourceDocument> {
    let promiseLabel = 'DS: Model#save ' + this;
    let resolver = RSVP.defer<null | SingleResourceDocument>(promiseLabel);
    let query: SaveRecordMutation = {
      op: 'saveRecord',
      recordIdentifier: identifier,
      options,
    };

    let queryRequest: Request = {
      data: [query],
    };

    let snapshot = new Snapshot(options, identifier, this._store);
    let pendingSaveItem = {
      snapshot: snapshot,
      resolver: resolver,
      identifier,
      options,
      queryRequest,
    };
    this._pendingSave.push(pendingSaveItem);
    emberBackburner.scheduleOnce('actions', this, this._flushPendingSaves);

    this.requestCache.enqueue(resolver.promise, pendingSaveItem.queryRequest);

    return resolver.promise;
  }

  _flushPendingSave(pending: PendingSaveItem) {
    let { snapshot, resolver, identifier, options } = pending;
    let adapter = this._store.adapterFor(identifier.type);
    let operation = options[SaveOp];

    let modelName = snapshot.modelName;
    let store = this._store;
    let modelClass = store.modelFor(modelName);
    const record = store._instanceCache.getRecord(identifier);

    assert(`You tried to update a record but you have no adapter (for ${modelName})`, adapter);
    assert(
      `You tried to update a record but your adapter (for ${modelName}) does not implement '${operation}'`,
      typeof adapter[operation] === 'function'
    );

    let promise = resolve().then(() => adapter[operation](store, modelClass, snapshot));
    let serializer: SerializerWithParseErrors | null = store.serializerFor(modelName);
    let label = `DS: Extract and notify about ${operation} completion of ${identifier}`;

    assert(
      `Your adapter's '${operation}' method must return a value, but it returned 'undefined'`,
      promise !== undefined
    );

    promise = _guard(guardDestroyedStore(promise, store, label), _bind(_objectIsAlive, record)).then(
      (adapterPayload) => {
        if (!_objectIsAlive(record)) {
          if (DEPRECATE_RSVP_PROMISE) {
            deprecate(
              `A Promise while saving ${modelName} did not resolve by the time your model was destroyed. This will error in a future release.`,
              false,
              {
                id: 'ember-data:rsvp-unresolved-async',
                until: '5.0',
                for: '@ember-data/store',
                since: {
                  available: '4.5',
                  enabled: '4.5',
                },
              }
            );
          }
        }

        if (adapterPayload) {
          return normalizeResponseHelper(serializer, store, modelClass, adapterPayload, snapshot.id, operation);
        }
      }
    );
    resolver.resolve(promise);
  }

  /**
    This method is called at the end of the run loop, and
    flushes any records passed into `scheduleSave`

    @method flushPendingSave
    @internal
  */
  _flushPendingSaves() {
    let pending = this._pendingSave.slice();
    this._pendingSave = [];
    for (let i = 0, j = pending.length; i < j; i++) {
      let pendingItem = pending[i];
      this._flushPendingSave(pendingItem);
    }
  }

  scheduleFetch(identifier: StableExistingRecordIdentifier, options: FindOptions): Promise<StableRecordIdentifier> {
    // TODO Probably the store should pass in the query object
    let shouldTrace = DEBUG && this._store.generateStackTracesForTrackedRequests;

    let query: FindRecordQuery = {
      op: 'findRecord',
      recordIdentifier: identifier,
      options,
    };

    let queryRequest: Request = {
      data: [query],
    };

    let pendingFetch = this.getPendingFetch(identifier, options);
    if (pendingFetch) {
      return pendingFetch;
    }

    let id = identifier.id;
    let modelName = identifier.type;

    let resolver = RSVP.defer<SingleResourceDocument>(`Fetching ${modelName}' with id: ${id}`);
    let pendingFetchItem: PendingFetchItem = {
      identifier,
      resolver,
      options,
      queryRequest,
    } as PendingFetchItem;

    if (DEBUG) {
      if (shouldTrace) {
        let trace;

        try {
          throw new Error(`Trace Origin for scheduled fetch for ${modelName}:${id}.`);
        } catch (e) {
          trace = e;
        }

        // enable folks to discover the origin of this findRecord call when
        // debugging. Ideally we would have a tracked queue for requests with
        // labels or local IDs that could be used to merge this trace with
        // the trace made available when we detect an async leak
        pendingFetchItem.trace = trace;
      }
    }

    let resolverPromise = resolver.promise;
    const store = this._store;
    const isLoading = !store._instanceCache.recordIsLoaded(identifier); // we don't use isLoading directly because we are the request

    const promise = resolverPromise.then(
      (payload) => {
        // ensure that regardless of id returned we assign to the correct record
        if (payload.data && !Array.isArray(payload.data)) {
          payload.data.lid = identifier.lid;
        }

        // additional data received in the payload
        // may result in the merging of identifiers (and thus records)
        let potentiallyNewIm = store._push(payload);
        if (potentiallyNewIm && !Array.isArray(potentiallyNewIm)) {
          return potentiallyNewIm;
        }

        return identifier;
      },
      (error) => {
        const recordData = store._instanceCache.peek({ identifier, bucket: 'recordData' });
        if (!recordData || recordData.isEmpty?.() || isLoading) {
          store._instanceCache.unloadRecord(identifier);
        }
        throw error;
      }
    );

    if (this._pendingFetch.size === 0) {
      emberBackburner.schedule('actions', this, this.flushAllPendingFetches);
    }

    let fetches = this._pendingFetch;

    if (!fetches.has(modelName)) {
      fetches.set(modelName, []);
    }

    (fetches.get(modelName) as PendingFetchItem[]).push(pendingFetchItem);

    pendingFetchItem.promise = promise;
    this.requestCache.enqueue(resolverPromise, pendingFetchItem.queryRequest);
    return promise;
  }

  _fetchRecord(fetchItem: PendingFetchItem) {
    let identifier = fetchItem.identifier;
    let modelName = identifier.type;
    let adapter = this._store.adapterFor(modelName);

    assert(`You tried to find a record but you have no adapter (for ${modelName})`, adapter);
    assert(
      `You tried to find a record but your adapter (for ${modelName}) does not implement 'findRecord'`,
      typeof adapter.findRecord === 'function'
    );

    let snapshot = new Snapshot(fetchItem.options, identifier, this._store);
    let klass = this._store.modelFor(identifier.type);
    let id = identifier.id;
    let label = `DS: Handle Adapter#findRecord of '${modelName}' with id: '${id}'`;

    let promise = guardDestroyedStore(
      resolve().then(() => {
        return adapter.findRecord(this._store, klass, identifier.id, snapshot);
      }),
      this._store,
      label
    ).then((adapterPayload) => {
      assert(
        `You made a 'findRecord' request for a '${modelName}' with id '${id}', but the adapter's response did not have any data`,
        !!payloadIsNotBlank(adapterPayload)
      );
      let serializer = this._store.serializerFor(modelName);
      let payload = normalizeResponseHelper(serializer, this._store, klass, adapterPayload, id, 'findRecord');
      assert(
        `Ember Data expected the primary data returned from a 'findRecord' response to be an object but instead it found an array.`,
        !Array.isArray(payload.data)
      );
      assert(
        `The 'findRecord' request for ${modelName}:${id} resolved indicating success but contained no primary data. To indicate a 404 not found you should either reject the promise returned by the adapter's findRecord method or throw a NotFoundError.`,
        'data' in payload && payload.data !== null && typeof payload.data === 'object'
      );

      warn(
        `You requested a record of type '${modelName}' with id '${id}' but the adapter returned a payload with primary data having an id of '${payload.data.id}'. Use 'store.findRecord()' when the requested id is the same as the one returned by the adapter. In other cases use 'store.queryRecord()' instead.`,
        coerceId(payload.data.id) === coerceId(id),
        {
          id: 'ds.store.findRecord.id-mismatch',
        }
      );

      return payload;
    });

    fetchItem.resolver.resolve(promise);
  }

  // TODO should probably refactor expectedSnapshots to be identifiers
  handleFoundRecords(
    seeking: { [id: string]: PendingFetchItem },
    coalescedPayload: CollectionResourceDocument,
    expectedSnapshots: Snapshot[]
  ) {
    // resolve found records
    let found = Object.create(null);
    let payloads = coalescedPayload.data;
    let coalescedIncluded = coalescedPayload.included || [];
    for (let i = 0, l = payloads.length; i < l; i++) {
      let payload = payloads[i];
      let pair = seeking[payload.id];
      found[payload.id] = payload;
      let included = coalescedIncluded.concat(payloads);

      // TODO remove original data from included
      if (pair) {
        let resolver = pair.resolver;
        resolver.resolve({ data: payload, included });
      }
    }

    // reject missing records

    // TODO NOW clean this up to refer to payloads
    let missingSnapshots: Snapshot[] = [];

    for (let i = 0, l = expectedSnapshots.length; i < l; i++) {
      let snapshot = expectedSnapshots[i];
      assertIsString(snapshot.id);

      // We know id is a string because you can't fetch
      // without one.
      if (!found[snapshot.id]) {
        missingSnapshots.push(snapshot);
      }
    }

    if (missingSnapshots.length) {
      warn(
        'Ember Data expected to find records with the following ids in the adapter response but they were missing: [ "' +
          missingSnapshots.map((r) => r.id).join('", "') +
          '" ]',
        false,
        {
          id: 'ds.store.missing-records-from-adapter',
        }
      );
      this.rejectFetchedItems(seeking, missingSnapshots);
    }
  }

  rejectFetchedItems(seeking: { [id: string]: PendingFetchItem }, snapshots: Snapshot[], error?) {
    for (let i = 0, l = snapshots.length; i < l; i++) {
      let snapshot = snapshots[i];
      assertIsString(snapshot.id);
      // TODO refactor to identifier.lid to avoid this cast to string
      //  we can do this case because you can only fetch an identifier
      //  that has an ID
      let pair = seeking[snapshot.id];

      if (pair) {
        pair.resolver.reject(
          error ||
            new Error(
              `Expected: '<${snapshot.modelName}:${snapshot.id}>' to be present in the adapter provided payload, but it was not found.`
            )
        );
      }
    }
  }

  _findMany(
    adapter: any,
    store: Store,
    modelName: string,
    snapshots: Snapshot[],
    identifiers: RecordIdentifier[],
    optionsMap
  ) {
    let modelClass = store.modelFor(modelName); // `adapter.findMany` gets the modelClass still
    let ids = snapshots.map((s) => s.id);
    let promise = adapter.findMany(store, modelClass, ids, snapshots);
    let label = `DS: Handle Adapter#findMany of '${modelName}'`;

    if (promise === undefined) {
      throw new Error('adapter.findMany returned undefined, this was very likely a mistake');
    }

    promise = guardDestroyedStore(promise, store, label);

    return promise.then(
      (adapterPayload) => {
        assert(
          `You made a 'findMany' request for '${modelName}' records with ids '[${ids}]', but the adapter's response did not have any data`,
          !!payloadIsNotBlank(adapterPayload)
        );
        let serializer = store.serializerFor(modelName);
        let payload = normalizeResponseHelper(serializer, store, modelClass, adapterPayload, null, 'findMany');
        return payload;
      },
      null,
      `DS: Extract payload of ${modelName}`
    );
  }

  _processCoalescedGroup(
    seeking: { [id: string]: PendingFetchItem },
    group: Snapshot[],
    adapter: any,
    optionsMap,
    modelName: string
  ) {
    //TODO check what happened with identifiers here
    let totalInGroup = group.length;
    let ids = new Array(totalInGroup);
    let groupedSnapshots = new Array(totalInGroup);

    for (let j = 0; j < totalInGroup; j++) {
      groupedSnapshots[j] = group[j];
      ids[j] = groupedSnapshots[j].id;
    }

    let store = this._store;
    if (totalInGroup > 1) {
      this._findMany(adapter, store, modelName, group, groupedSnapshots, optionsMap)
        .then((payloads) => {
          this.handleFoundRecords(seeking, payloads, groupedSnapshots);
        })
        .catch((error) => {
          this.rejectFetchedItems(seeking, groupedSnapshots, error);
        });
    } else if (ids.length === 1) {
      let pair = seeking[groupedSnapshots[0].id];
      this._fetchRecord(pair);
    } else {
      assert("You cannot return an empty array from adapter's method groupRecordsForFindMany", false);
    }
  }

  _flushPendingFetchForType(pendingFetchItems: PendingFetchItem[], modelName: string) {
    let adapter = this._store.adapterFor(modelName);
    let shouldCoalesce = !!adapter.findMany && adapter.coalesceFindRequests;
    let totalItems = pendingFetchItems.length;
    let identifiers = new Array(totalItems);
    let seeking: { [id: string]: PendingFetchItem } = Object.create(null);

    let optionsMap = new WeakCache<RecordIdentifier, FindOptions>(DEBUG ? 'fetch-options' : '');

    for (let i = 0; i < totalItems; i++) {
      let pendingItem = pendingFetchItems[i];
      let identifier = pendingItem.identifier;
      identifiers[i] = identifier;
      optionsMap.set(identifier, pendingItem.options);
      seeking[identifier.id] = pendingItem;
    }

    if (shouldCoalesce) {
      // TODO: Improve records => snapshots => records => snapshots
      //
      // We want to provide records to all store methods and snapshots to all
      // adapter methods. To make sure we're doing that we're providing an array
      // of snapshots to adapter.groupRecordsForFindMany(), which in turn will
      // return grouped snapshots instead of grouped records.
      //
      // But since the _findMany() finder is a store method we need to get the
      // records from the grouped snapshots even though the _findMany() finder
      // will once again convert the records to snapshots for adapter.findMany()
      let snapshots = new Array<Snapshot>(totalItems);
      for (let i = 0; i < totalItems; i++) {
        // we know options is in the map due to having just set it above
        // but TS doesn't know so we cast it
        let options = optionsMap.get(identifiers[i]) as Dict<unknown>;
        snapshots[i] = new Snapshot(options, identifiers[i], this._store);
      }

      let groups: Snapshot[][];
      if (adapter.groupRecordsForFindMany) {
        groups = adapter.groupRecordsForFindMany(this._store, snapshots);
      } else {
        groups = [snapshots];
      }

      for (let i = 0, l = groups.length; i < l; i++) {
        this._processCoalescedGroup(seeking, groups[i], adapter, optionsMap, modelName);
      }
    } else {
      for (let i = 0; i < totalItems; i++) {
        this._fetchRecord(pendingFetchItems[i]);
      }
    }
  }

  getPendingFetch(identifier: StableRecordIdentifier, options: FindOptions) {
    let pendingFetches = this._pendingFetch.get(identifier.type);

    // We already have a pending fetch for this
    if (pendingFetches) {
      let matchingPendingFetch = pendingFetches.find((fetch) => fetch.identifier === identifier);
      if (matchingPendingFetch && isSameRequest(options, matchingPendingFetch.options)) {
        return matchingPendingFetch.promise;
      }
    }
  }

  flushAllPendingFetches() {
    if (this.isDestroyed) {
      return;
    }

    this._pendingFetch.forEach(this._flushPendingFetchForType, this);
    this._pendingFetch.clear();
  }

  destroy() {
    this.isDestroyed = true;
  }
}

function assertIsString(id: string | null): asserts id is string {
  if (DEBUG) {
    if (typeof id !== 'string') {
      throw new Error(`Cannot fetch record without an id`);
    }
  }
}

// this function helps resolve whether we have a pending request that we should use instead
// TODO @runspired @needsTest removing this did not cause any test failures
function isSameRequest(options: FindOptions = {}, reqOptions: FindOptions = {}) {
  return options.include === reqOptions.include;
}
