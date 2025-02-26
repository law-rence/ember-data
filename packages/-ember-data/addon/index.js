import 'ember-inflector';

import { dependencySatisfies, importSync, macroCondition } from '@embroider/macros';

import Adapter, { BuildURLMixin } from '@ember-data/adapter';
import AdapterError, {
  AbortError,
  ConflictError,
  errorsArrayToHash,
  errorsHashToArray,
  ForbiddenError,
  InvalidError,
  NotFoundError,
  ServerError,
  TimeoutError,
  UnauthorizedError,
} from '@ember-data/adapter/error';
import JSONAPIAdapter from '@ember-data/adapter/json-api';
import RESTAdapter from '@ember-data/adapter/rest';
import Model, { attr, belongsTo, hasMany } from '@ember-data/model';
import Serializer from '@ember-data/serializer';
import { BooleanTransform, DateTransform, NumberTransform, StringTransform } from '@ember-data/serializer/-private';
import JSONSerializer from '@ember-data/serializer/json';
import JSONAPISerializer from '@ember-data/serializer/json-api';
import RESTSerializer, { EmbeddedRecordsMixin } from '@ember-data/serializer/rest';
import Transform from '@ember-data/serializer/transform';
import Store, { normalizeModelName } from '@ember-data/store';

import {
  AdapterPopulatedRecordArray,
  DS,
  Errors,
  ManyArray,
  PromiseArray,
  PromiseManyArray,
  PromiseObject,
  RecordArray,
  RecordArrayManager,
  Relationship,
  Snapshot,
} from './-private';
import setupContainer from './setup-container';

DS.Store = Store;
DS.PromiseArray = PromiseArray;
DS.PromiseObject = PromiseObject;

DS.PromiseManyArray = PromiseManyArray;

DS.Model = Model;
DS.attr = attr;
DS.Errors = Errors;

DS.Snapshot = Snapshot;

DS.Adapter = Adapter;

DS.AdapterError = AdapterError;
DS.InvalidError = InvalidError;
DS.TimeoutError = TimeoutError;
DS.AbortError = AbortError;

DS.UnauthorizedError = UnauthorizedError;
DS.ForbiddenError = ForbiddenError;
DS.NotFoundError = NotFoundError;
DS.ConflictError = ConflictError;
DS.ServerError = ServerError;

DS.errorsHashToArray = errorsHashToArray;
DS.errorsArrayToHash = errorsArrayToHash;

DS.Serializer = Serializer;

if (macroCondition(dependencySatisfies('@ember-data/debug', '*'))) {
  DS.DebugAdapter = importSync('@ember-data/debug').default;
}

DS.RecordArray = RecordArray;
DS.AdapterPopulatedRecordArray = AdapterPopulatedRecordArray;
DS.ManyArray = ManyArray;

DS.RecordArrayManager = RecordArrayManager;

DS.RESTAdapter = RESTAdapter;
DS.BuildURLMixin = BuildURLMixin;

DS.RESTSerializer = RESTSerializer;
DS.JSONSerializer = JSONSerializer;

DS.JSONAPIAdapter = JSONAPIAdapter;
DS.JSONAPISerializer = JSONAPISerializer;

DS.Transform = Transform;
DS.DateTransform = DateTransform;
DS.StringTransform = StringTransform;
DS.NumberTransform = NumberTransform;
DS.BooleanTransform = BooleanTransform;

DS.EmbeddedRecordsMixin = EmbeddedRecordsMixin;

DS.belongsTo = belongsTo;
DS.hasMany = hasMany;

DS.Relationship = Relationship;

DS._setupContainer = setupContainer;

Object.defineProperty(DS, 'normalizeModelName', {
  enumerable: true,
  writable: false,
  configurable: false,
  value: normalizeModelName,
});

export default DS;
