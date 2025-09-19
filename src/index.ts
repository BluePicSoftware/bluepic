import { nanoid } from './util/query';

export type BxTemplateOptions = {
  cloudflarePagesHostname: string;
  embedApiBaseUrl: string;
  useBoilerplate: boolean;
  env: 'dev' | 'prod';
  config: {
    fonts?: { name: string; src: string }[];
    webgl?: boolean;
    resolution?: number;
  };
}

function getCloudflareLiveUrl(bxCoreVersion: string | undefined, options: BxTemplateOptions) {
  return `https://${bxCoreVersion ? `${bxCoreVersion.replace(/\./g, '-')}.` : ''}${
    options.cloudflarePagesHostname
  }`;
}
// export function getTemplateSerialUrl(id: string, options: BxTemplateOptions) {
//   return `${options.studioResourcesBaseUrl}${
//     options.authorization ? `/auth.proxy/${options.authorization}` : ''
//   }/api/files/${id}/default`;
// }

export function getTemplateSerialUrl(templateId: string, options: BxTemplateOptions) {
  return `${options.embedApiBaseUrl}/api/public/project/serial/${templateId}?${
    new URLSearchParams({
      env: options.env,
    }).toString()
  }`
}
export function getTemplatePreviewUrl(
  templateId: string,
  options: {
    embedApiBaseUrl: string;
    env: 'dev' | 'prod';
  }
) {
  return `${options.embedApiBaseUrl}/api/public/project/preview/${templateId}?${
    new URLSearchParams({
      env: options.env,
    }).toString()
  }`
}


export function getTemplateLiveUrl(id: string, knownBxCoreVersion: string | undefined, options: BxTemplateOptions) {
  // New live
  const baseUrl = getCloudflareLiveUrl(knownBxCoreVersion, options);
  return (
    `${baseUrl}?` +
    new URLSearchParams(
      Object.fromEntries(
        Object.entries({
          fonts: JSON.stringify(options.config.fonts ?? []),
          webgl: options.config.webgl,
          resolution: options.config.resolution,
          autoDetectBxCoreVersion: knownBxCoreVersion === undefined,
          resolveSerial: options.useBoilerplate ? undefined : getTemplateSerialUrl(id, options),
        }).filter(([, value]) => value && value !== 'null')
      ) as { [k: string]: any }
    ).toString()
  );
}

export function optimizePreviewUrl(url: string, width?: number, height?: number) {
  try {
    const previewUrlObj = new URL(url);
    // If this is a cloudlfare imagedelivery url
    if (previewUrlObj.hostname === 'imagedelivery.net') {
      const [, scope, imageId, verionKey] = previewUrlObj.pathname.split('/');
      return `https://imagedelivery.net/${scope}/${imageId}/${
        width || height
          ? new URLSearchParams(
              Object.fromEntries(
                (
                  Object.entries({ w: width, h: height }).filter(([key, value]) => value !== undefined) as [string, number][]
                ).map(([key, value]) => [key, String(value)])
              )
            ).toString()
          : verionKey
      }`;
    }
  } catch (err) {
    console.error(err);

    return url;
  }
}

export default class EmbeddedController extends EventTarget {
  iframe: HTMLIFrameElement;
  alive: boolean;
  ready: boolean;
  sessionId: string | null;
  $data: { [k: string]: any };
  constructor(iframe: HTMLIFrameElement, serialPromise?: Promise<any | undefined>, maxRetries = 5) {
    super();
    this.iframe = iframe;

    this.alive = true;
    this.ready = false;
    this.sessionId = null;

    this.initListener();
    let mounted = false;
    let serialPromiseResolved = false;
    // if (serialPromise !== undefined) {
    //   serialPromise.then(() => serialPromiseResolved = true);
    // }
    this.addEventListener('mounted', async () => {
      // If serial promise is a thing and it's not resolved yet, this mounted event is the boilerplate's one
      if (serialPromise !== undefined && !serialPromiseResolved) {
        // Wait for serial promise to resolve
        const serial = await serialPromise;
        serialPromiseResolved = true;
        if (serial) {
          // Inject the serial promise's serial into the iframe sandbox
          await this.evaluate((serialStringified: string) => {
            const serial = JSON.parse(serialStringified);
            (window as any).bx_serial.value = serial;
          }, JSON.stringify(serial));
        }
        // If serial promise did not returned anything, we have an error
        else {
          this.dispatchEvent(new CustomEvent('error', { detail: { code: 2 } }));
        }
      } else if (!mounted) {
        // Now, we're defefinitely mounted and ready
        mounted = true;
        this.dispatchEvent(new CustomEvent('ready'));
      }
    });

    this.addEventListener('setGlobalScope', (event) => {
      const globalScope = Object.fromEntries(
        Object.entries((event as any).detail as { [k: string]: any }).map(([key, value]) => {
          if (value?.__type__ === 'function') {
            return [key, new Function(`return (${value!.__value__})()`)];
          } else {
            return [key, value];
          }
        })
      );
      const globalScopeEvent = new CustomEvent('globalScope', { detail: globalScope });
      this.dispatchEvent(globalScopeEvent);
    });

    const pinger: ReturnType<typeof setInterval> = setInterval(async () => {
      if (!this.alive) return clearInterval(pinger);
      try {
        if (await this.ping()) {
          clearInterval(pinger);
          // this.emit('ready');
        }
      } catch {
        //console.error('failed ping');
      }
    }, 5);

    this.$data = new Proxy(this, {
      get(target, name) {
        return target.get(name as string);
      },
      set(target, name, value) {
        //selfRef.$proxy[name] = value;
        return target.set(name as string, value);
      },
    });

    let retries = 0;

    this.addEventListener('http:error', (event) => {
      const code = (event as any).detail?.code;
      if (code >= 400) {
        console.error('ERROR DURING LIVE REQUEST', code);
        if (code === 412) {
          if (retries < maxRetries) {
            const currUrl = new URL(iframe.src);
            currUrl.searchParams.set('force', Date.now().toString());
            iframe.src = currUrl.toString();
            retries++;
          } else {
            this.dispatchEvent(new CustomEvent('error', { detail: { code: 412 } }));
          }
        }
      }
    });
  }
  destroy() {
    this.alive = false;
  }
  ping(timeout = 100) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const id = now;
      const timer = setTimeout(reject, timeout);
      const thisMessageListener = ({ data }: MessageEvent) => {
        if (this.alive && data.type == 'pong' && data.id == id) {
          resolve(Date.now() - now);
          clearTimeout(timer);
          window.removeEventListener('message', thisMessageListener);
        }
      };
      window.addEventListener('message', thisMessageListener);
      try {
        this.iframe.contentWindow?.postMessage({ type: 'ping', id }, '*');
      } catch {
        // void
      }
    });
  }
  getSessionId() {
    return new Promise<string>((resolve) => {
      const taskId = nanoid();
      this.apply('getSessionId', taskId);
      window.addEventListener('message', ({ data }) => {
        if (data.scope === 'bx' && data.taskId === taskId) {
          resolve(data.sessionId);
        }
      });
    });
  }
  private messageIsSession(data: any) {
    return data.sessionId == this.sessionId;
  }
  private messageIsEvent(data: any) {
    return data.type == 'event';
  }
  initListener() {
    window.addEventListener(
      'message',
      async ({ data }) => {
        if (data.error) {
          console.error('ERROR FROM LIVE SANDBOX', data);
          if (data?.response?.error === 'File ist not embedded') {
            this.dispatchEvent(new CustomEvent('error', { detail: { code: 2 } }));
          } else {
            this.dispatchEvent(new CustomEvent('error', { detail: { code: 1 } }));
          }
        }
        if (this.messageIsSession(data)) {
          if (data.taskId) {
            this.dispatchEvent(new CustomEvent('rerender'));
            //this.emit('rerender');
          }
          if (this.messageIsEvent(data)) {
            const newEvent = new CustomEvent(data.message, { detail: data.payload });
            this.dispatchEvent(newEvent);
            //this.emit(data.message, data.payload);
          }
        }
        if (data.type === 'bx:init') {
          const newSessionId = await this.getSessionId();
          if (newSessionId != this.sessionId) {
            this.sessionId = newSessionId;
            //this.emit('init');
            this.dispatchEvent(new CustomEvent('init'));
          }
          //this.emit('roll');
          this.dispatchEvent(new CustomEvent('roll'));
        }
        if (data.type === 'event' && data.message === 'mounted') {
          //this.emit('ready');
          this.dispatchEvent(new CustomEvent('mounted'));
        }
        // Deprecated support
        // if (data?.type === 'event' && data?.message === 'ready') {
        //   const iframeUrl = new URL(this.iframe.src);
        //   const fixSessionId = iframeUrl.searchParams.get('sessionId');
        //   if (fixSessionId && fixSessionId === data.sessionId) {
        //     this.sessionId = fixSessionId;
        //     this.emit('ready');
        //   }
        // }
      },
      false
    );
  }
  apply(name: string, ...args: any[]) {
    try {
      this.iframe.contentWindow?.postMessage(
        {
          type: 'action',
          name,
          args,
        },
        '*'
      );
    } catch (e) {
      console.error(e);
    }
  }
  get(name: string) {
    return this.evaluate((name: string) => {
      return this.$data[name];
    }, name);
  }
  set(name: string, value: string) {
    this.apply('set', name, value);
    return true;
  }
  // Yes, it's evil but there is nothing malicous on our templates and this makes it easier to communicate a lot
  // eslint-disable-next-line @typescript-eslint/ban-types
  evaluate(func: Function, ...args: string[]) {
    return new Promise((resolve, reject) => {
      const processId = nanoid();
      this.apply('evaluate', func.toString(), processId, args);
      const onReturn = ({ detail: event }: any) => {
        if (event.processId == processId) {
          try {
            resolve(JSON.parse(event.result));
          } catch (e) {
            resolve(event.result);
          }
          this.removeEventListener('return', onReturn);
          this.removeEventListener('error', onError);
        }
      };
      const onError = ({ detail: event }: any) => {
        if (event.processId == processId) {
          reject(event.error);
          this.removeEventListener('return', onReturn);
          this.removeEventListener('error', onError);
        }
      };
      this.addEventListener('return', onReturn);
      this.addEventListener('error', onError);
    });
  }
  setData(data: { [k: string]: any }) {
    return new Promise((resolve, reject) => {
      this.evaluate((dataSerialized: string) => {
        const data = JSON.parse(dataSerialized);
        for (const key in data) {
          (window as any).bx_data[key] = data[key];
        }
      }, JSON.stringify(data))
        .then((v) => {
          resolve(v);
        })
        .catch((e) => {
          reject(e);
        });
    });
  }
  transform(scale: number, x: number, y: number, origin: { x: string; y: string }) {
    this.apply('transform', scale, x, y, origin);
  }
}
