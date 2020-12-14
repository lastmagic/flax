/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, {AxiosError, AxiosResponse, ResponseType} from 'axios';
import LRU from 'lru-cache';
import queryString from 'query-string';
import {MutableRefObject} from 'react';

const cache = new LRU({max: 100, maxAge: 1000 * 60 * 10});

type QueryType = string | number | boolean;
type Queries = {[key: string]: QueryType | QueryType[]};
type Headers = {[key: string]: string};
type DataTypeValues = string | number | boolean | null;
type DataType = {
  [key: string]:
    | DataTypeValues
    | MutableRefObject<HTMLElement | null>
    | DataType;
};
type Data = DataType | (() => DataType) | string;

export type FxResp<T, TR> = {data: T; reduced: TR; response: AxiosResponse<T>};

interface FxErrorResponse<T, TR> extends AxiosResponse<T> {
  reduced: TR;
}

export interface FxError<T, TR> extends AxiosError<T> {
  response?: FxErrorResponse<T, TR>;
}

export interface FxApiRequest<TR = any, TE = any, TRR = TR, TER = TE> {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  url: string;
  cacheMaxAge?: number;
  throttle?: boolean;
  delay?: number;
  responseType?: ResponseType;
  query?: Queries;
  headers?: Headers;
  data?: Data;
  reducer?: (data: TR) => TRR;
  errReducer?: (data: TE, error: AxiosError<TE>) => TER;
}

interface RequestProps<TR, TE, TRR, TER>
  extends FxApiRequest<TR, TE, TRR, TER> {
  refreshId?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resolver = (data: any) => void;
type Rejector = (reason: Error) => void;

const resolving = (
  resolve: Resolver,
  reject: Rejector,
  props: RequestProps<any, any, any, any>,
  resp: AxiosResponse | null,
  error: FxError<any, any> | null
) => {
  if (error) {
    if (error.response?.data) {
      if (props.errReducer) {
        error.response.reduced = props.errReducer(error.response?.data, error);
      } else {
        error.response.reduced = error.response?.data;
      }
    }

    reject(error);
  } else {
    resolve({
      data: resp?.data,
      reduced: props.reducer ? props.reducer(resp?.data) : resp?.data,
      response: resp,
    });
  }
};

const resolvers: {
  [key: string]: Array<{
    resolve: Resolver;
    reject: Rejector;
    props: RequestProps<any, any, any, any>;
  }>;
} = {};

const resolver = (
  resolver: {
    resolve: Resolver;
    reject: Rejector;
    props: RequestProps<any, any, any, any>;
  },
  key: string | null,
  resp: AxiosResponse | null,
  error: FxError<any, any> | null,
  startAt: Date,
  cacheKey: string | null
) => {
  if (cacheKey && resolver.props.cacheMaxAge) {
    cache.set(cacheKey, {data: resp?.data}, resolver.props.cacheMaxAge);
  }

  if (!key) {
    const delay =
      (resolver.props.delay || 0) - (new Date().getTime() - startAt.getTime());

    setTimeout(() => {
      resolving(resolver.resolve, resolver.reject, resolver.props, resp, error);
    }, Math.max(delay, 0));
    return;
  }

  const res = resolvers[key].splice(0, resolvers[key].length);

  res.forEach(({resolve, reject, props}) => {
    const delay =
      (props.delay || 0) - (new Date().getTime() - startAt.getTime());

    setTimeout(() => {
      resolving(resolve, reject, props, resp, error);
    }, Math.max(delay, 0));
  });
};

const dataMapper = (data: DataType | string | null | undefined) => {
  if (!data) return data;
  if (typeof data !== 'object') return data;

  return Object.keys(data).reduce<{[key: string]: any}>((p, c) => {
    if (typeof data[c] === 'object') {
      if ((data[c] as any).current instanceof HTMLElement) {
        p[c] = (data[c] as any).current.value;
      } else {
        p[c] = dataMapper(data[c] as any);
      }
    } else {
      p[c] = data[c];
    }
    return p;
  }, {});
};

function setDefaultHeader(headerParam: {key: string, val: string}) {
  const {key, val} = headerParam;
  axios.defaults.headers.common[key] = val;
}

export function setDefaultHeaders(headers: Array<any>) {
  headers.forEach(e => {
    const key = e.key;
    const val = e.val;

    setDefaultHeader({key, val});
  })
}

export function request<TR, TE, TRR, TER>(
  props: RequestProps<TR, TE, TRR, TER>
): Promise<FxResp<TR, TRR>> {
  return new Promise<FxResp<TR, TRR>>((resolve, reject) => {
    setTimeout(() => {
      const url = ((u, query) => {
        const qs = queryString.stringify(query);
        return u + (qs ? (u.includes('?') ? '&' : '?') + qs : '');
      })(props.url, props.query || {});

      const cacheKey =
        props.method === 'GET' && props.cacheMaxAge && props.cacheMaxAge > 0
          ? `${props.method} ${props.url} ${props.cacheMaxAge}`
          : null;
      const cached = cacheKey && cache.get(cacheKey);

      if (cached) {
        resolver(
          {resolve, reject, props},
          null,
          cached as AxiosResponse,
          null,
          new Date(),
          null
        );
        return;
      }

      const lazyGroup =
        props.method === 'GET' && props.throttle
          ? `${props.method} ${url} ${props.delay || 0}`
          : null;

      if (lazyGroup) {
        resolvers[lazyGroup] = resolvers[lazyGroup] || [];
        resolvers[lazyGroup].push({resolve, reject, props});

        // Duplicated `GET` request,
        if (resolvers[lazyGroup].length > 1) {
          return;
        }
      }

      const start = new Date();

      axios
        .request<TR>({
          method: props.method,
          url,
          headers: props.headers,
          responseType: props.responseType,
          data: dataMapper(
            typeof props.data === 'function' ? props.data() : props.data
          ),
        })
        .then(resp => {
          resolver(
            {resolve, reject, props},
            lazyGroup,
            resp,
            null,
            start,
            cacheKey
          );
        })
        .catch(err => {
          resolver({resolve, reject, props}, lazyGroup, null, err, start, null);
        });
    }, 25);
  });
}
