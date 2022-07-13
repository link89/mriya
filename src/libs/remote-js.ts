import _ from 'lodash';
import CDP from 'chrome-remote-interface';
import { getLogger } from 'log4js';
import { InfluxdbOptions } from './telemetry';

const toExpression = (fn: Function, args: any[] = []) => {
  return `(${fn.toString()}).apply(this, ${JSON.stringify(args)})`;
};

export class RemoteJs {
  private cdp!: CDP.Client;
  private logger = getLogger(`[${this.constructor.name}]`);

  /**
   * create multiple RemoteJs instances from configuration string
   * @param endpoints configuration string in the format HOST1:PORT1,HOST2:PORT2,...
   */
  static fromEndpoints(endpoints: string): RemoteJs[] {
    return endpoints.split(',').map(endpoint => RemoteJs.fromEndpoint(endpoint));
  }

  static fromEndpoint(endpoint: string): RemoteJs {
    const [host, port] = endpoint.split(":");
    return new RemoteJs({ host, port: Number(port) });
  }

  static fromLocalEndpoints(total: number = 20, startPort: number = 9000): RemoteJs[] {
    return _.range(0, total).map(i => new RemoteJs({ port: startPort + i }));
  }

  constructor(private cdpOpts: CDP.Options) {
  }

  async connect() {
    this.cdp = await CDP(this.cdpOpts);
  }

  async execute(fn: Function, args: any[] = []) {
    const expression = toExpression(fn, args);
    this.logger.debug(expression);
    const ret = await this.cdp.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (ret.exceptionDetails) {
      throw Error(JSON.stringify(ret.exceptionDetails, null, 2));
    }
    return ret.result.value;
  }

  async enableInfluxDB(options: InfluxdbOptions) {
    console.log(`aggregate id: ${options.aggregateId}`);
    return await this.execute((options: InfluxdbOptions) => $remote.telemetry.enableInfluxDB(options), [options]);
  }

  async flushInfluxDB() {
    return await this.execute(() => $remote.telemetry.flush());
  }

  async getTelemtryRecords(chunk: number = -1) {
    return await this.execute((chunk: number) => $remote.telemetry.getEvents(chunk), [chunk]);
  }

  async dispose() {
    await this.execute(() => process.exit(0));
    await this.cdp.close();
  }
}
