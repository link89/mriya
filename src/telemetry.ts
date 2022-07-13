import appInsights from 'applicationinsights';
import fs from 'fs';
import { InfluxDB, Point, WriteApi, ClientOptions } from "@influxdata/influxdb-client";
import _ from 'lodash';
import { nanoid } from 'nanoid';

let _nonce = 0
function nanoNonce(): string {
  _nonce = (_nonce + 1) % 1_000_000;
  return String(_nonce).padStart(6, '0');
}

export type TelemetryRecord = appInsights.Contracts.EnvelopeTelemetry;
export type ValueType = number | boolean | string | [number, 'u' | 'i'];

interface IEvent {
  type: string;
  ts?: number;  // timestamp in milliseconds
  tags: { [key: string]: string};
  fields: { [key: string]: ValueType };
}

export interface InfluxdbOptions {
  aggregateId: string;
  org?: string;
  bucket?: string;
  clientOptions: ClientOptions;
}

export function isHttpData(envelop: TelemetryRecord) {
  const data = envelop.data;
  return "Http" == data.baseData?.type
}

export function hmsToSeconds(hms: string) {
  const [hours, minutes, seconds] = hms.split(':');
  return Number(hours) * 60 * 60 + Number(minutes) * 60 + Number(seconds);
};

export type EventTransformer = (event: IEvent) => IEvent;

class TelemetryAgent {
  public readonly instanceId: string = `${new Date().toISOString()}-${process.pid}-${process.debugPort}`;

  private events: IEvent[] = [];
  private dataFiles: string[] = [];
  private transformers: EventTransformer[] = [];

  public dbWriter?: WriteApi;

  constructor(
  ) { }

  public addTransformer(fn: EventTransformer) {
    this.transformers.push(fn);
  }

  public addEvent(event: IEvent) {
    if (!event.ts) {
      event.ts = Date.now();
    }
    for (const transformer of this.transformers) {
      event = transformer(event);
    }
    this.events.push(event);
    if (this.dbWriter) {
      const point = new Point(event.type);
      point.timestamp(`${event.ts}${nanoNonce()}`);  // reduce the chance of event conflict
      for (const [key, value] of Object.entries(event.tags)) {
        point.tag(key, value);
      }
      for (const [key, value] of Object.entries(event.fields)) {
        switch (typeof value) {
          case 'number': point.floatField(key, value); break;
          case 'boolean': point.booleanField(key, value); break;
          case 'string': point.stringField(key, value); break;
          case 'undefined': break;
          case 'object': {
            if (null === value) break;
            const [num, type] = value;
            if ('i' === type) {
              point.intField(key, num);
            } else if ('u' === type) {
              point.uintField(key, num);
            } else {
              throw Error(`Invalid field value: ${value}`);
            }
            break;
          }
          default: throw Error(`Invalid field value: ${value}`);
        }
      }
      this.dbWriter.writePoint(point);
    }
    if (this.events.length > 1e4) {
      this.flushToDisk();
    }
  }

  private flushToDisk() {
    const dataFile = `./data/telemetry-${this.instanceId}-${this.dataFiles.length}.json`;
    fs.writeFileSync(dataFile, JSON.stringify(this.events));  // FIXME: using async write
    this.dataFiles.push(dataFile);
    this.events = [];
  }

  public async flush() {
    this.flushToDisk();
    if (this.dbWriter) {
      await this.dbWriter.flush(true);
    }
  }

  public getEvents(chunk: number = -1): IEvent[] | undefined {
    // get all events
    if (chunk < 0) {
      const chunks = [];
      for (let i = 0; i <= this.dataFiles.length; i++) {
        chunks.push(this.getEvents(i)!);
      }
      return _.flatten(chunks);
    }
    // chunk in file
    if (chunk < this.dataFiles.length) {
      return JSON.parse(fs.readFileSync(this.dataFiles[chunk], { encoding: 'utf-8' }));
    }
    // chunk in memory
    if (chunk == this.dataFiles.length) {
      return this.events;
    }
    // invalid chunk number
    return undefined;
  }
}
const _agent = new TelemetryAgent();

const defaultProcessor = (envelop: TelemetryRecord) => {
  if (isHttpData(envelop)) {
    const httpData = envelop.data.baseData!;
    addEvent({
      type: 'http',
      ts: Date.parse(envelop.time),
      tags: {
        name: httpData.name,
        resultCode: httpData.resultCode,
        target: httpData.target,
      },
      fields: {
        duration: httpData.duration ? hmsToSeconds(httpData.duration) : 0,
        success: httpData.success,
      },
    });
  }
  return false;
}

// Public API
export const init = (processor = defaultProcessor) => {
  appInsights.setup('00000000-0000-0000-0000-000000000000') // using nil
    .setAutoCollectConsole(false)
    .setAutoCollectDependencies(true) // trace http outbound request
    .setAutoCollectExceptions(false)
    .setAutoCollectHeartbeat(false)
    .setAutoCollectPerformance(false)
    .setAutoCollectPreAggregatedMetrics(false)
    .setAutoCollectRequests(false)
    .setAutoDependencyCorrelation(false)
    .setSendLiveMetrics(false)
    .setUseDiskRetryCaching(false);

  appInsights.defaultClient.config.disableAppInsights = true;
  appInsights.defaultClient.config.disableAllExtendedMetrics = true;
  appInsights.defaultClient.config.disableStatsbeat = true;
  appInsights.defaultClient.addTelemetryProcessor(processor);
  appInsights.start();
}

export const enableInfluxDB = (options: InfluxdbOptions) => {
  const influxDb = new InfluxDB(options.clientOptions);
  const aggregateId = options.aggregateId;
  const org = options.org || 'null-org';
  const bucket = options.bucket || 'null-bucket';
  const writeOptions = {
    defaultTags: {
      aggregateId,
      instanceId: nanoid(), // this tag is to reduce the chance of event conflict
    },
    // batchSize: 1e3,
    flushInterval: 2e3,
    // maxBufferLines: 100e3,
    maxRetries: 3,
    maxRetryDelay: 15000,
    minRetryDelay: 3000,
    retryJitter: 1000,
    // gzipThreshold: 2048,
    ...options.clientOptions.writeOptions,
  };
  _agent.dbWriter = influxDb.getWriteApi(org, bucket, 'ns', writeOptions);
}

export const addEvent = (event: IEvent) => _agent.addEvent(event);
export const getEvents = (chunk: number = -1) => _agent.getEvents(chunk);
export const addTransformer = (fn: EventTransformer) => _agent.addTransformer(fn);
export const flush = async () => await _agent.flush();
