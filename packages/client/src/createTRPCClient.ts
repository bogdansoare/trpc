/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  AnyRouter,
  ClientDataTransformerOptions,
  DataTransformer,
  inferHandlerInput,
  inferProcedureInput,
  inferProcedureOutput,
  inferSubscriptionOutput,
  Maybe,
  TRPCProcedureErrorEnvelope,
  TRPCProcedureSuccessEnvelope,
} from '@trpc/server';
import { executeChain } from './internals/executeChain';
import { getAbortController, getFetch } from './internals/fetchHelpers';
import { observableSubjectAsPromise } from './internals/observable';
import {
  CancelFn,
  LinkRuntimeOptions,
  OperationContext,
  OperationLink,
  OperationResult,
  TRPCLink,
} from './links/core';
import { httpLink } from './links/httpLink';

type CancellablePromise<T = unknown> = Promise<T> & {
  cancel: CancelFn;
};

/* istanbul ignore next */
const retryDelay = (attemptIndex: number) =>
  attemptIndex === 0 ? 0 : Math.min(1000 * 2 ** attemptIndex, 30000);

export class TRPCClientError<TRouter extends AnyRouter> extends Error {
  public readonly result?: Maybe<TRPCProcedureErrorEnvelope<TRouter>>;
  public readonly res?: Maybe<Response>;
  public readonly originalError?: Maybe<Error>;
  public readonly shape?: TRPCProcedureErrorEnvelope<TRouter>['error'];

  constructor(
    message: string,
    {
      result,
      originalError,
    }: {
      result: Maybe<TRPCProcedureErrorEnvelope<TRouter>>;
      originalError: Maybe<Error>;
    },
  ) {
    super(message);
    this.message = message;
    this.result = result;
    this.originalError = originalError;
    this.shape = this.result?.error;

    Object.setPrototypeOf(this, TRPCClientError.prototype);
  }

  public static from<TRouter extends AnyRouter>(
    result: Error | TRPCProcedureErrorEnvelope<TRouter>,
  ): TRPCClientError<TRouter> {
    if (!(result instanceof Error)) {
      return new TRPCClientError<TRouter>((result.error as any).message ?? '', {
        originalError: null,
        result,
      });
    }

    if (result.name === 'TRPCClientError') {
      return result;
    }

    return new TRPCClientError<TRouter>(result.message, {
      originalError: result,
      result: null,
    });
  }
}

export interface FetchOptions {
  fetch?: typeof fetch;
  AbortController?: typeof AbortController;
}

export type CreateTRPCClientOptions<TRouter extends AnyRouter> = {
  /**
   * @deprecated likely to be removed
   */
  onSuccess?: (data: TRPCProcedureSuccessEnvelope<unknown>) => void;
  /**
   * @deprecated likely to be removed
   */
  onError?: (error: TRPCClientError<TRouter>) => void;
  /**
   * add ponyfills for fetch / abortcontroller
   */
  fetchOpts?: FetchOptions;
  headers?:
    | LinkRuntimeOptions['headers']
    | ReturnType<LinkRuntimeOptions['headers']>;
  transformer?: ClientDataTransformerOptions;
} & (
  | {
      url: string;
    }
  | {
      links: TRPCLink<TRouter>[];
    }
);
type TRPCType = 'subscription' | 'query' | 'mutation';

export type RequestOptions = {
  context?: OperationContext;
};
export class TRPCClient<TRouter extends AnyRouter> {
  private readonly links: OperationLink<TRouter>[];
  public readonly runtime: LinkRuntimeOptions;
  private opts: CreateTRPCClientOptions<TRouter>;

  constructor(opts: CreateTRPCClientOptions<TRouter>) {
    this.opts = opts;
    const transformer: DataTransformer = opts.transformer
      ? 'input' in opts.transformer
        ? {
            serialize: opts.transformer.input.serialize,
            deserialize: opts.transformer.output.deserialize,
          }
        : opts.transformer
      : {
          serialize: (data) => data,
          deserialize: (data) => data,
        };

    const _fetch = getFetch(opts.fetchOpts?.fetch);
    const AC = getAbortController(opts.fetchOpts?.AbortController);

    function getHeadersFn(): LinkRuntimeOptions['headers'] {
      if (opts.headers) {
        const headers = opts.headers;
        return typeof headers === 'function' ? headers : () => headers;
      }
      return () => ({});
    }
    this.runtime = {
      transformer,
      AbortController: AC as any,
      fetch: _fetch as any,
      headers: getHeadersFn(),
    };

    if ('links' in opts) {
      this.links = opts.links.map((link) => link(this.runtime));
    } else {
      this.links = [
        httpLink({
          url: opts.url,
        })(this.runtime),
      ];
    }
    /**
     * @deprecated
     * prepending a link to call `onSuccess` / `onError`
     */
    if (this.opts.onError || this.opts.onError) {
      // deprecation warning?
      this.links = [
        ({ op, next, prev }) => {
          next(op, (result) => {
            result instanceof Error
              ? this.opts?.onError?.(result)
              : this.opts?.onSuccess?.(result);

            prev(result);
          });
        },
        ...this.links,
      ];
    }
  }

  /**
   * @deprecated will be turned private
   */
  public request<TInput = unknown, TOutput = unknown>(opts: {
    type: TRPCType;
    input: TInput;
    path: string;
    context?: OperationContext;
  }) {
    return this.requestAsPromise<TInput, TOutput>(opts);
  }

  private $request<TInput = unknown, TOutput = unknown>({
    type,
    input,
    path,
    context = {},
  }: {
    type: TRPCType;
    input: TInput;
    path: string;
    context?: OperationContext;
  }) {
    const $result = executeChain<TRouter, TInput, TOutput>({
      links: this.links as any,
      op: {
        type,
        path,
        input,
        context,
      },
    });

    return $result;
  }
  private requestAsPromise<TInput = unknown, TOutput = unknown>(opts: {
    type: TRPCType;
    input: TInput;
    path: string;
    context?: OperationContext;
  }): CancellablePromise<TOutput> {
    const $result = this.$request<TInput, TOutput>(opts);

    type TResult = typeof $result;
    type TValue = OperationResult<TRouter, TOutput> | null;
    const promiseAndCancel =
      observableSubjectAsPromise<TResult, TValue>($result);
    const promise = new Promise<TOutput>((resolve, reject) => {
      promiseAndCancel.promise
        .then((result) => {
          if (!result) {
            return;
          }
          result instanceof Error ? reject(result) : resolve(result.data);
        })
        .catch((err) => {
          reject(err);
        });
    }) as CancellablePromise<TOutput>;
    promise.cancel = promiseAndCancel.cancel;

    return promise;
  }
  public query<
    TQueries extends TRouter['_def']['queries'],
    TPath extends string & keyof TQueries,
  >(
    path: TPath,
    ...args: [...inferHandlerInput<TQueries[TPath]>, RequestOptions?]
  ) {
    const context = (args[1] as RequestOptions | undefined)?.context;
    return this.requestAsPromise<
      inferHandlerInput<TQueries[TPath]>,
      inferProcedureOutput<TQueries[TPath]>
    >({
      type: 'query',
      path,
      input: args[0] as any,
      context,
    });
  }

  public mutation<
    TMutations extends TRouter['_def']['mutations'],
    TPath extends string & keyof TMutations,
  >(
    path: TPath,
    ...args: [...inferHandlerInput<TMutations[TPath]>, RequestOptions?]
  ) {
    const context = (args[1] as RequestOptions | undefined)?.context;
    return this.requestAsPromise<
      inferHandlerInput<TMutations[TPath]>,
      inferProcedureOutput<TMutations[TPath]>
    >({
      type: 'mutation',
      path,
      input: args[0] as any,
      context,
    });
  }
  /* istanbul ignore next */
  public subscriptionOnce<
    TSubscriptions extends TRouter['_def']['subscriptions'],
    TPath extends string & keyof TSubscriptions,
    TOutput extends inferSubscriptionOutput<TRouter, TPath>,
    TInput extends inferProcedureInput<TSubscriptions[TPath]>,
  >(
    path: TPath,
    input: TInput,
    opts?: RequestOptions,
  ): CancellablePromise<TOutput[]> {
    let stopped = false;
    let nextTry: any; // setting as `NodeJS.Timeout` causes compat issues, can probably be solved
    let currentRequest: CancellablePromise<TOutput[]> | null = null;
    const context = opts?.context;
    const promise = new Promise<TOutput[]>((resolve, reject) => {
      const exec = async () => {
        if (stopped) {
          return;
        }
        try {
          currentRequest = this.requestAsPromise({
            type: 'subscription',
            input,
            path,
            context,
          });
          const data = await currentRequest;

          resolve(data as any);
        } catch (_err) {
          const err: TRPCClientError<TRouter> = _err;

          if (err.result?.statusCode === 408) {
            // server told us to reconnect
            exec();
          } else {
            reject(err);
          }
        }
      };
      exec();
    }) as CancellablePromise<TOutput[]>;
    promise.cancel = () => {
      stopped = true;
      clearTimeout(nextTry);
      currentRequest?.cancel && currentRequest.cancel();
    };

    return promise as any as CancellablePromise<TOutput[]>;
  }
  /* istanbul ignore next */
  /**
   * @deprecated - legacy stuff for http subscriptions
   */
  public subscription<
    TSubscriptions extends TRouter['_def']['subscriptions'],
    TPath extends string & keyof TSubscriptions,
    TOutput extends inferSubscriptionOutput<TRouter, TPath>,
    TInput extends inferProcedureInput<TSubscriptions[TPath]>,
  >(
    path: TPath,
    opts: {
      initialInput: TInput;
      onError?: (err: TRPCClientError<TRouter>) => void;
      onData?: (data: TOutput[]) => void;
      /**
       * Input cursor for next call to subscription endpoint
       */
      nextInput: (data: TOutput[]) => TInput;
      context?: OperationContext;
    },
  ): CancelFn {
    let stopped = false;

    // let nextTry: any; // setting as `NodeJS.Timeout` causes compat issues, can probably be solved
    let currentPromise: CancellablePromise<TOutput[]> | null = null;

    let attemptIndex = 0;
    const unsubscribe: CancelFn = () => {
      stopped = true;
      currentPromise?.cancel();
      currentPromise = null;
    };
    const exec = async (input: TInput) => {
      try {
        currentPromise = this.subscriptionOnce(path, input);
        const res = await currentPromise;
        attemptIndex = 0;
        opts.onData && opts.onData(res);

        const nextInput = opts.nextInput(res);
        exec(nextInput);
      } catch (err) {
        if (stopped) {
          return;
        }
        opts.onError && opts.onError(err);
        attemptIndex++;
        setTimeout(() => {
          exec(input);
        }, retryDelay(attemptIndex));
      }
    };
    exec(opts.initialInput);
    return unsubscribe;
  }

  public $subscription<
    TSubscriptions extends TRouter['_def']['subscriptions'],
    TPath extends string & keyof TSubscriptions,
    TOutput extends inferSubscriptionOutput<TRouter, TPath>,
    TInput extends inferProcedureInput<TSubscriptions[TPath]>,
  >(
    path: TPath,
    ...args: [...inferHandlerInput<TSubscriptions[TPath]>, RequestOptions?]
  ) {
    const context = (args[1] as RequestOptions | undefined)?.context;
    const $res = this.$request<TInput, TOutput>({
      type: 'subscription',
      path,
      input: args[0] as any,
      context,
    });
    return $res;
  }
}

export function createTRPCClient<TRouter extends AnyRouter>(
  opts: CreateTRPCClientOptions<TRouter>,
) {
  return new TRPCClient<TRouter>(opts);
}
