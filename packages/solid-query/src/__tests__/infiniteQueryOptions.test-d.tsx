import { describe, expectTypeOf, it } from 'vitest'
import { dataTagSymbol } from '@tanstack/query-core'
import { queryKey } from '@tanstack/query-test-utils'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { infiniteQueryOptions } from '../infiniteQueryOptions'
import type { InfiniteData } from '@tanstack/query-core'
import type {
  DefinedInitialDataInfiniteOptions,
  UndefinedInitialDataInfiniteOptions,
} from '../infiniteQueryOptions'

describe('infiniteQueryOptions', () => {
  it('preserves readonly keys and inferred page parameters through the helper', () => {
    const options = infiniteQueryOptions({
      queryKey: ['packed', 'infinite'] as const,
      queryFn: async ({ pageParam }) => ({ page: pageParam }),
      initialPageParam: 0,
      getNextPageParam: (last) => (last.page < 1 ? last.page + 1 : undefined),
    })

    expectTypeOf(useInfiniteQuery(() => options).data).toEqualTypeOf<
      InfiniteData<{ page: number }>
    >()
  })

  it('preserves selected data, defined initial data, and custom errors', () => {
    class PageError extends Error {
      readonly pageCode = 'page'
    }
    const options = infiniteQueryOptions<
      { page: number },
      PageError,
      Array<number>,
      readonly ['selected', 'infinite'],
      number
    >({
      queryKey: ['selected', 'infinite'],
      queryFn: async ({ pageParam }) => ({ page: pageParam }),
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      initialData: { pages: [{ page: 0 }], pageParams: [0] },
      select: (data) => data.pages.map((page) => page.page),
    })
    const result = useInfiniteQuery(() => options)

    expectTypeOf(result.data).toEqualTypeOf<Array<number>>()
    expectTypeOf(result.error).toEqualTypeOf<PageError | null>()
    expectTypeOf(result.isPending).toEqualTypeOf<false>()
  })

  it('should infer defined types', () => {
    const options = infiniteQueryOptions({
      getNextPageParam: () => 10,
      queryKey: queryKey(),
      queryFn: () => ({ wow: true }),
      initialData: {
        pageParams: [undefined],
        pages: [{ wow: true }],
      },
      initialPageParam: 0,
    })

    expectTypeOf(useInfiniteQuery(() => options).data).toEqualTypeOf<
      InfiniteData<{ wow: boolean }, unknown>
    >()

    expectTypeOf(options).toExtend<
      ReturnType<
        DefinedInitialDataInfiniteOptions<
          { wow: boolean },
          Error,
          InfiniteData<{ wow: boolean }, unknown>,
          Array<string>,
          number | undefined
        >
      >
    >()

    expectTypeOf(options.queryKey[dataTagSymbol]).toEqualTypeOf<
      InfiniteData<{ wow: boolean }>
    >()
  })

  it('should work without defined types', () => {
    const options = infiniteQueryOptions({
      getNextPageParam: () => undefined,
      queryKey: queryKey(),
      queryFn: () => ({ wow: true }),
      initialPageParam: 0,
    })

    // Non-optional even without initialData: `data` is a suspending read.
    expectTypeOf(() => useInfiniteQuery(() => options).data).toEqualTypeOf<
      () => InfiniteData<{ wow: boolean }, unknown>
    >()

    expectTypeOf(options).toExtend<
      ReturnType<
        UndefinedInitialDataInfiniteOptions<
          { wow: boolean },
          Error,
          InfiniteData<{ wow: boolean }, unknown>,
          Array<string>,
          number
        >
      >
    >()

    expectTypeOf(options.queryKey[dataTagSymbol]).toEqualTypeOf<
      InfiniteData<{
        wow: boolean
      }>
    >()
  })
})
