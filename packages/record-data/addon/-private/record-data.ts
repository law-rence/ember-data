/**
 * @module @ember-data/record-data
 */
import { isEqual } from '@ember/utils';

import type { RecordDataStoreWrapper } from '@ember-data/store/-private';
import { recordIdentifierFor } from '@ember-data/store/-private';
import type { CollectionResourceRelationship } from '@ember-data/types/q/ember-data-json-api';
import type { RecordIdentifier, StableRecordIdentifier } from '@ember-data/types/q/identifier';
import type { ChangedAttributesHash, RecordData } from '@ember-data/types/q/record-data';
import type { AttributesHash, JsonApiResource, JsonApiValidationError } from '@ember-data/types/q/record-data-json-api';
import type {
  DefaultSingleResourceRelationship,
  RelationshipRecordData,
} from '@ember-data/types/q/relationship-record-data';

import { isImplicit } from './graph/-utils';
import { graphFor } from './graph/index';
import type BelongsToRelationship from './relationships/state/belongs-to';
import type ManyRelationship from './relationships/state/has-many';

const EMPTY_ITERATOR = {
  iterator() {
    return {
      next() {
        return { done: true, value: undefined };
      },
    };
  },
};

/**
  The default cache implementation used by ember-data. The cache
  is configurable and using a different implementation can be
  achieved by implementing the store's createRecordDataFor hook.

  @class RecordDataDefault
  @public
 */
export default class RecordDataDefault implements RelationshipRecordData {
  declare _errors?: JsonApiValidationError[];
  declare modelName: string;
  declare lid: string;
  declare identifier: StableRecordIdentifier;
  declare isDestroyed: boolean;
  declare _isNew: boolean;
  declare __attributes: any;
  declare __inFlightAttributes: any;
  declare __data: any;
  declare _isDeleted: boolean;
  declare _isDeletionCommited: boolean;
  declare storeWrapper: RecordDataStoreWrapper;

  constructor(identifier: RecordIdentifier, storeWrapper: RecordDataStoreWrapper) {
    this.modelName = identifier.type;
    this.lid = identifier.lid;
    this.identifier = identifier;
    this.storeWrapper = storeWrapper;

    this.isDestroyed = false;
    this._isNew = false;
    this._isDeleted = false;
    this.reset();
  }

  get id() {
    return this.identifier.id;
  }

  // PUBLIC API
  getResourceIdentifier(): StableRecordIdentifier {
    return this.identifier;
  }

  pushData(data: JsonApiResource, calculateChange: true): string[];
  pushData(data: JsonApiResource, calculateChange?: false): void;
  pushData(data: JsonApiResource, calculateChange?: boolean): string[] | void {
    let changedKeys;

    if (this._isNew) {
      this._isNew = false;
      this.notifyStateChange();
    }

    if (calculateChange) {
      changedKeys = this._changedKeys(data.attributes);
    }

    Object.assign(this._data, data.attributes);
    if (this.__attributes) {
      // only do if we have attribute changes
      this._updateChangedAttributes();
    }

    if (data.relationships) {
      this._setupRelationships(data);
    }

    if (changedKeys && changedKeys.length) {
      this._notifyAttributes(changedKeys);
    }

    return changedKeys;
  }

  willCommit() {
    this._inFlightAttributes = this._attributes;
    this._attributes = null;
  }

  hasChangedAttributes() {
    return this.__attributes !== null && Object.keys(this.__attributes).length > 0;
  }

  _clearErrors() {
    if (this._errors) {
      this._errors = undefined;
      this.storeWrapper.notifyErrorsChange(this.modelName, this.id, this.lid);
    }
  }

  getErrors(): JsonApiValidationError[] {
    let errors: JsonApiValidationError[] = this._errors || [];
    return errors;
  }

  // this is a hack bc we don't have access to the state machine
  //   and relationships need this info and @runspired didn't see
  //   how to get it just yet from storeWrapper.
  isEmpty() {
    return this.__attributes === null && this.__inFlightAttributes === null && this.__data === null;
  }

  isDeleted() {
    return this._isDeleted;
  }

  setIsDeleted(isDeleted: boolean): void {
    this._isDeleted = isDeleted;
    if (this._isNew) {
      this._deletionConfirmed();
    }
    this.notifyStateChange();
  }

  isDeletionCommitted(): boolean {
    return this._isDeletionCommited;
  }

  reset() {
    this.__attributes = null;
    this.__inFlightAttributes = null;
    this.__data = null;
    this._errors = undefined;
  }

  _setupRelationships(data) {
    // TODO @runspired iterating by definitions instead of by payload keys
    // allows relationship payloads to be ignored silently if no relationship
    // definition exists. Ensure there's a test for this and then consider
    // moving this to an assertion. This check should possibly live in the graph.
    let relationships = this.storeWrapper.relationshipsDefinitionFor(this.modelName);
    let keys = Object.keys(relationships);
    for (let i = 0; i < keys.length; i++) {
      let relationshipName = keys[i];

      if (!data.relationships[relationshipName]) {
        continue;
      }

      let relationshipData = data.relationships[relationshipName];

      graphFor(this.storeWrapper).push({
        op: 'updateRelationship',
        record: this.identifier,
        field: relationshipName,
        value: relationshipData,
      });
    }
  }

  /**
    Checks if the attributes which are considered as changed are still
    different to the state which is acknowledged by the server.

    This method is needed when data for the internal model is pushed and the
    pushed data might acknowledge dirty attributes as confirmed.

    @method updateChangedAttributes
    @private
   */
  _updateChangedAttributes() {
    let changedAttributes = this.changedAttributes();
    let changedAttributeNames = Object.keys(changedAttributes);
    let attrs = this._attributes;

    for (let i = 0, length = changedAttributeNames.length; i < length; i++) {
      let attribute = changedAttributeNames[i];
      let data = changedAttributes[attribute];
      let oldData = data[0];
      let newData = data[1];

      if (oldData === newData) {
        delete attrs[attribute];
      }
    }

    this._notifyAttributes(changedAttributeNames);
  }

  _notifyAttributes(keys?: string[]) {
    const { type, id, lid } = this.identifier;
    const manager = this.storeWrapper;

    if (!keys) {
      manager.notifyPropertyChange(type, id, lid);
      return;
    }

    for (let i = 0; i < keys.length; i++) {
      manager.notifyPropertyChange(type, id, lid, keys[i]);
    }
  }

  /**
    Returns an object, whose keys are changed properties, and value is an
    [oldProp, newProp] array.

    @method changedAttributes
    @private
  */
  changedAttributes(): ChangedAttributesHash {
    let oldData = this._data;
    let currentData = this._attributes;
    let inFlightData = this._inFlightAttributes;
    let newData = { ...inFlightData, ...currentData };
    let diffData = Object.create(null);
    let newDataKeys = Object.keys(newData);

    for (let i = 0, length = newDataKeys.length; i < length; i++) {
      let key = newDataKeys[i];
      diffData[key] = [oldData[key], newData[key]];
    }

    return diffData;
  }

  isNew() {
    return this._isNew;
  }

  rollbackAttributes() {
    let dirtyKeys;
    this._isDeleted = false;

    if (this.hasChangedAttributes()) {
      dirtyKeys = Object.keys(this._attributes);
      this._attributes = null;
    }

    if (this.isNew()) {
      this.removeFromInverseRelationships();
      this._isDeleted = true;
      this._isNew = false;
    }

    this._inFlightAttributes = null;

    this._clearErrors();
    this.notifyStateChange();

    if (dirtyKeys && dirtyKeys.length) {
      this._notifyAttributes(dirtyKeys);
    }

    return dirtyKeys;
  }

  _deletionConfirmed() {
    this.removeFromInverseRelationships();
  }

  didCommit(data: JsonApiResource | null) {
    if (this._isDeleted) {
      this._deletionConfirmed();
      this._isDeletionCommited = true;
    }

    this._isNew = false;
    let newCanonicalAttributes: AttributesHash | undefined;
    if (data) {
      if (data.id) {
        // didCommit provided an ID, notify the store of it
        this.storeWrapper.setRecordId(this.modelName, data.id, this.lid);
      }
      if (data.relationships) {
        this._setupRelationships(data);
      }
      newCanonicalAttributes = data.attributes;
    }
    let changedKeys = this._changedKeys(newCanonicalAttributes);

    Object.assign(this._data, this.__inFlightAttributes, newCanonicalAttributes);

    this._inFlightAttributes = null;

    this._updateChangedAttributes();
    this._notifyAttributes(changedKeys);
    this._clearErrors();

    this.notifyStateChange();
    return changedKeys;
  }

  notifyStateChange() {
    this.storeWrapper.notifyStateChange(this.modelName, this.id, this.lid);
  }

  // get ResourceIdentifiers for "current state"
  getHasMany(key: string): CollectionResourceRelationship {
    return (graphFor(this.storeWrapper).get(this.identifier, key) as ManyRelationship).getData();
  }

  // set a new "current state" via ResourceIdentifiers
  setDirtyHasMany(key: string, recordDatas: RecordData[]) {
    graphFor(this.storeWrapper).update({
      op: 'replaceRelatedRecords',
      record: this.identifier,
      field: key,
      value: recordDatas.map(recordIdentifierFor),
    });
  }

  // append to "current state" via RecordDatas
  addToHasMany(key: string, recordDatas: RecordData[], idx?: number) {
    graphFor(this.storeWrapper).update({
      op: 'addToRelatedRecords',
      record: this.identifier,
      field: key,
      value: recordDatas.map(recordIdentifierFor),
      index: idx,
    });
  }

  // remove from "current state" via RecordDatas
  removeFromHasMany(key: string, recordDatas: RecordData[]) {
    graphFor(this.storeWrapper).update({
      op: 'removeFromRelatedRecords',
      record: this.identifier,
      field: key,
      value: recordDatas.map(recordIdentifierFor),
    });
  }

  commitWasRejected(identifier?, errors?: JsonApiValidationError[]) {
    let keys = Object.keys(this._inFlightAttributes);
    if (keys.length > 0) {
      let attrs = this._attributes;
      for (let i = 0; i < keys.length; i++) {
        if (attrs[keys[i]] === undefined) {
          attrs[keys[i]] = this._inFlightAttributes[keys[i]];
        }
      }
    }
    this._inFlightAttributes = null;
    if (errors) {
      this._errors = errors;
    }
    this.storeWrapper.notifyErrorsChange(this.modelName, this.id, this.lid);
  }

  getBelongsTo(key: string): DefaultSingleResourceRelationship {
    return (graphFor(this.storeWrapper).get(this.identifier, key) as BelongsToRelationship).getData();
  }

  setDirtyBelongsTo(key: string, recordData: RecordData | null) {
    graphFor(this.storeWrapper).update({
      op: 'replaceRelatedRecord',
      record: this.identifier,
      field: key,
      value: recordData ? recordIdentifierFor(recordData) : null,
    });
  }

  setDirtyAttribute(key: string, value: any) {
    const { type, id, lid } = this.identifier;

    this.storeWrapper.notifyPropertyChange(type, id, lid, key);
    let originalValue;
    // Add the new value to the changed attributes hash
    this._attributes[key] = value;

    if (key in this._inFlightAttributes) {
      originalValue = this._inFlightAttributes[key];
    } else {
      originalValue = this._data[key];
    }
    // If we went back to our original value, we shouldn't keep the attribute around anymore
    if (value === originalValue) {
      delete this._attributes[key];
    }
  }

  getAttr(key: string): string {
    if (key in this._attributes) {
      return this._attributes[key];
    } else if (key in this._inFlightAttributes) {
      return this._inFlightAttributes[key];
    } else {
      return this._data[key];
    }
  }

  hasAttr(key: string): boolean {
    return key in this._attributes || key in this._inFlightAttributes || key in this._data;
  }

  unloadRecord() {
    if (this.isDestroyed) {
      return;
    }
    const { storeWrapper } = this;
    graphFor(storeWrapper).unload(this.identifier);
    this.reset();

    let relatedIdentifiers = this._allRelatedRecordDatas();
    if (areAllModelsUnloaded(this.storeWrapper, relatedIdentifiers)) {
      // we don't have a backburner queue yet since
      // we scheduled this into ember's destroy
      // disconnectRecord called from destroy will teardown
      // relationships. We do this to queue that.
      this.storeWrapper._store._backburner.join(() => {
        for (let i = 0; i < relatedIdentifiers.length; ++i) {
          let identifier = relatedIdentifiers[i];
          storeWrapper.disconnectRecord(identifier.type, identifier.id, identifier.lid);
        }
      });
    }

    this.isDestroyed = true;
  }

  isRecordInUse() {
    return this.storeWrapper.isRecordInUse(this.modelName, this.id, this.lid);
  }

  /*
    Iterates over the set of internal models reachable from `this` across exactly one
    relationship.
  */
  _directlyRelatedRecordDatasIterable = () => {
    const graph = graphFor(this.storeWrapper);
    const initializedRelationships = graph.identifiers.get(this.identifier);

    if (!initializedRelationships) {
      return EMPTY_ITERATOR;
    }

    const initializedRelationshipsArr = Object.keys(initializedRelationships)
      .map((key) => initializedRelationships[key]!)
      .filter((rel) => {
        return !isImplicit(rel);
      });

    let i = 0;
    let j = 0;
    let k = 0;

    const findNext = () => {
      while (i < initializedRelationshipsArr.length) {
        while (j < 2) {
          let members =
            j === 0 ? getLocalState(initializedRelationshipsArr[i]) : getRemoteState(initializedRelationshipsArr[i]);
          while (k < members.length) {
            let member = members[k++];
            if (member !== null) {
              return member;
            }
          }
          k = 0;
          j++;
        }
        j = 0;
        i++;
      }
      return undefined;
    };

    return {
      iterator() {
        return {
          next: () => {
            const value = findNext();
            return { value, done: value === undefined };
          },
        };
      },
    };
  };

  /*
    Computes the set of Identifiers reachable from this Identifier.

    Reachability is determined over the relationship graph (ie a graph where
    nodes are identifiers and edges are belongs to or has many
    relationships).

    Returns an array including `this` and all identifiers reachable
    from `this.identifier`.
  */
  _allRelatedRecordDatas(): StableRecordIdentifier[] {
    let array: StableRecordIdentifier[] = [];
    let queue: StableRecordIdentifier[] = [];
    let seen = new Set();
    queue.push(this.identifier);
    while (queue.length > 0) {
      let identifier = queue.shift()!;
      array.push(identifier);
      seen.add(identifier);

      const iterator = this._directlyRelatedRecordDatasIterable().iterator();
      for (let obj = iterator.next(); !obj.done; obj = iterator.next()) {
        const identifier = obj.value;
        if (identifier && !seen.has(identifier)) {
          seen.add(identifier);
          queue.push(identifier);
        }
      }
    }

    return array;
  }

  get _attributes() {
    if (this.__attributes === null) {
      this.__attributes = Object.create(null);
    }
    return this.__attributes;
  }

  set _attributes(v) {
    this.__attributes = v;
  }

  get _data() {
    if (this.__data === null) {
      this.__data = Object.create(null);
    }
    return this.__data;
  }

  set _data(v) {
    this.__data = v;
  }

  get _inFlightAttributes() {
    if (this.__inFlightAttributes === null) {
      this.__inFlightAttributes = Object.create(null);
    }
    return this.__inFlightAttributes;
  }

  set _inFlightAttributes(v) {
    this.__inFlightAttributes = v;
  }

  /**
   * Receives options passed to `store.createRecord` and is given the opportunity
   * to handle them.
   *
   * The return value is an object of options to pass to `Record.create()`
   *
   * @name _initRecordCreateOptions
   * @param options
   * @private
   */
  _initRecordCreateOptions(options) {
    let createOptions = {};

    if (options !== undefined) {
      const { storeWrapper, identifier } = this;
      let attributeDefs = storeWrapper.attributesDefinitionFor(identifier.type);
      let relationshipDefs = storeWrapper.relationshipsDefinitionFor(identifier.type);
      const graph = graphFor(storeWrapper);
      let propertyNames = Object.keys(options);

      for (let i = 0; i < propertyNames.length; i++) {
        let name = propertyNames[i];
        let propertyValue = options[name];

        if (name === 'id') {
          continue;
        }

        let fieldType = relationshipDefs[name] || attributeDefs[name];
        let kind = fieldType !== undefined ? fieldType.kind : null;
        let relationship;

        switch (kind) {
          case 'attribute':
            this.setDirtyAttribute(name, propertyValue);
            break;
          case 'belongsTo':
            this.setDirtyBelongsTo(name, propertyValue);
            relationship = graph.get(identifier, name);
            relationship.state.hasReceivedData = true;
            relationship.state.isEmpty = false;
            break;
          case 'hasMany':
            this.setDirtyHasMany(name, propertyValue);
            relationship = graph.get(identifier, name);
            relationship.state.hasReceivedData = true;
            relationship.state.isEmpty = false;
            break;
          default:
            // reflect back (pass-thru) unknown properties
            createOptions[name] = propertyValue;
        }
      }
    }

    return createOptions;
  }

  removeFromInverseRelationships() {
    graphFor(this.storeWrapper).push({
      op: 'deleteRecord',
      record: this.identifier,
      isNew: this.isNew(),
    });
  }

  clientDidCreate() {
    this._isNew = true;
  }

  /*
    Ember Data has 3 buckets for storing the value of an attribute.

    `_data` holds all of the attributes that have been acknowledged by
    a backend via the adapter. When rollbackAttributes is called on a model all
    attributes will revert to the record's state in `_data`.

    `_attributes` holds any change the user has made to an attribute
    that has not been acknowledged by the adapter. Any values in
    `_attributes` are have priority over values in `_data`.

    `_inFlightAttributes`. When a record is being synced with the
    backend the values in `_attributes` are copied to
    `_inFlightAttributes`. This way if the backend acknowledges the
    save but does not return the new state Ember Data can copy the
    values from `_inFlightAttributes` to `_data`. Without having to
    worry about changes made to `_attributes` while the save was
    happenign.


    Changed keys builds a list of all of the values that may have been
    changed by the backend after a successful save.

    It does this by iterating over each key, value pair in the payload
    returned from the server after a save. If the `key` is found in
    `_attributes` then the user has a local changed to the attribute
    that has not been synced with the server and the key is not
    included in the list of changed keys.



    If the value, for a key differs from the value in what Ember Data
    believes to be the truth about the backend state (A merger of the
    `_data` and `_inFlightAttributes` objects where
    `_inFlightAttributes` has priority) then that means the backend
    has updated the value and the key is added to the list of changed
    keys.

    @method _changedKeys
    @private
  */
  /*
      TODO IGOR DAVID
      There seems to be a potential bug here, where we will return keys that are not
      in the schema
  */
  _changedKeys(updates?: AttributesHash) {
    let changedKeys: string[] = [];

    if (updates) {
      let original, i, value, key;
      let keys = Object.keys(updates);
      let length = keys.length;
      let hasAttrs = this.hasChangedAttributes();
      let attrs;
      if (hasAttrs) {
        attrs = this._attributes;
      }

      original = Object.assign(Object.create(null), this._data, this.__inFlightAttributes);

      for (i = 0; i < length; i++) {
        key = keys[i];
        value = updates[key];

        // A value in _attributes means the user has a local change to
        // this attributes. We never override this value when merging
        // updates from the backend so we should not sent a change
        // notification if the server value differs from the original.
        if (hasAttrs === true && attrs[key] !== undefined) {
          continue;
        }

        if (!isEqual(original[key], value)) {
          changedKeys.push(key);
        }
      }
    }

    return changedKeys;
  }

  toString() {
    return `<${this.modelName}:${this.id}>`;
  }
}

function areAllModelsUnloaded(wrapper: RecordDataStoreWrapper, identifiers: StableRecordIdentifier[]): boolean {
  for (let i = 0; i < identifiers.length; ++i) {
    let identifer = identifiers[i];
    if (wrapper.isRecordInUse(identifer.type, identifer.id, identifer.lid)) {
      return false;
    }
  }
  return true;
}

function getLocalState(rel) {
  if (rel.definition.kind === 'belongsTo') {
    return rel.localState ? [rel.localState] : [];
  }
  return rel.currentState;
}
function getRemoteState(rel) {
  if (rel.definition.kind === 'belongsTo') {
    return rel.remoteState ? [rel.remoteState] : [];
  }
  return rel.canonicalState;
}
