import { createPinia, defineStore } from '../src'
import { mount } from '@vue/test-utils'
import { App } from 'vue'

declare module '../src' {
  export interface PiniaCustomProperties<Id> {
    pluginN: number
    uid: App['_uid']
    hasApp: boolean
    idFromPlugin: Id
    globalA: string
    globalB: string
  }
}

describe('store plugins', () => {
  const useStore = defineStore({
    id: 'test',

    actions: {
      incrementN() {
        return this.pluginN++
      },
    },

    getters: {
      doubleN: (state) => state.pluginN * 2,
    },
  })

  it('adds properties to stores', () => {
    const pinia = createPinia()

    mount({ template: 'none' }, { global: { plugins: [pinia] } })

    // must call use after installing the plugin
    pinia.use(({ app }) => {
      return { pluginN: 20, uid: app._uid }
    })

    const store = useStore(pinia)

    expect(store.pluginN).toBe(20)
    expect(store.uid).toBeDefined()
    // @ts-expect-error: pluginN is a number
    store.pluginN.notExisting
    // @ts-expect-error: it should always be 'test'
    store.idFromPlugin == 'hello'
  })

  it('can install plugins before installing pinia', () => {
    const pinia = createPinia()

    pinia.use(() => ({ pluginN: 1 }))
    pinia.use(({ app }) => ({ uid: app._uid }))

    mount({ template: 'none' }, { global: { plugins: [pinia] } })

    pinia.use((app) => ({ hasApp: !!app }))

    const store = useStore(pinia)

    expect(store.pluginN).toBe(1)
    expect(store.uid).toBeDefined()
    expect(store.hasApp).toBe(true)
  })

  it('can be used in actions', () => {
    const pinia = createPinia()

    // must call use after installing the plugin
    pinia.use(() => {
      return { pluginN: 20 }
    })

    mount({ template: 'none' }, { global: { plugins: [pinia] } })

    const store = useStore(pinia)

    expect(store.incrementN()).toBe(20)
  })

  it('can be used in getters', () => {
    const pinia = createPinia()

    // must call use after installing the plugin
    pinia.use(() => {
      return { pluginN: 20 }
    })

    mount({ template: 'none' }, { global: { plugins: [pinia] } })

    const store = useStore(pinia)
    expect(store.doubleN).toBe(40)
  })

  it('allows chaining', () => {
    const pinia = createPinia()

    // must call use after installing the plugin
    pinia.use(() => ({ globalA: 'a' })).use(() => ({ globalB: 'b' }))

    mount({ template: 'none' }, { global: { plugins: [pinia] } })

    const store = useStore(pinia)
    expect(store.globalA).toBe('a')
    expect(store.globalB).toBe('b')
  })
})
