import { assertType, describe, expectTypeOf, it } from 'vitest'
import { QueryClient } from '..'
import type { QueryClient as CoreQueryClient } from '@tanstack/query-core'
import type { QueryClientProviderProps } from '..'

describe('QueryClient', () => {
  it('shares the host query-core client contract with the provider', () => {
    const client = new QueryClient()

    assertType<CoreQueryClient>(client)
    assertType<QueryClientProviderProps['client']>(client)
    expectTypeOf(client.query).toEqualTypeOf<CoreQueryClient['query']>()
    expectTypeOf(client.infiniteQuery).toEqualTypeOf<
      CoreQueryClient['infiniteQuery']
    >()
  })
})
