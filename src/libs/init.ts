import _ from 'lodash';
import Bluebird from 'bluebird';
import * as telemetry from './telemetry';

telemetry.init();

// use different name in remote nodejs process to avoid mixing up with the local one,
// becuase typescript don't have option to preserve method name when using Function.toString()
Object.assign(global, {
  $remote: {
    _,
    telemetry,
    BlueBird: Bluebird,
  }
});

// delcare the global variables of remote node so that it can pass the type check of typescript
declare global {

  const $remote: {
    _: typeof _,
    telemetry: typeof telemetry,
    BlueBird: typeof Bluebird,
  }

};
