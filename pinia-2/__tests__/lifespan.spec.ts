import { createPinia, defineStore, setActivePinia } from '../src'
import { mount } from '@vue/test-utils'
import { watch, nextTick, defineComponent, ref, Ref } from 'vue'

describe('Store Lifespan', () => {
  function defineMyStore() {
    return defineStore({
      id: 'main',
      state: () => ({
        a: true,
        n: 0,
        aRef: ref(0),
        nested: {
          foo: 'foo',
          a: { b: 'string' },
        },
      }),
      getters: {
        double(state) {
          return state.n * 2
        },
        notA(state) {
          return !state.a
        },
      },
    })
  }

  const pinia = createPinia()

  it('state reactivity outlives component life', async () => {
    const useStore = defineMyStore()

    const inComponentWatch = jest.fn()

    const Component = defineComponent({
      render: () => null,
      setup() {
        const store = useStore()
        watch(() => store.n, inComponentWatch)
        store.n++
      },
    })

    const options = {
      global: {
        plugins: [pinia],
      },
    }

    let wrapper = mount(Component, options)

    await wrapper.unmount()

    expect(inComponentWatch).toHaveBeenCalledTimes(1)

    let store = useStore()
    store.n++
    await nextTick()
    expect(inComponentWatch).toHaveBeenCalledTimes(1)

    wrapper = mount(Component, options)
    await wrapper.unmount()

    expect(inComponentWatch).toHaveBeenCalledTimes(2)

    store = useStore()
    store.n++
    await nextTick()
    expect(inComponentWatch).toHaveBeenCalledTimes(2)
  })

  it('ref in state reactivity outlives component life', async () => {
    let n: Ref<number>
    const pinia = createPinia()
    setActivePinia(pinia)
    const globalWatch = jest.fn()
    const destroy = watch(() => pinia.state.value.a?.n, globalWatch)

    const useStore = defineStore({
      id: 'a',
      state: () => {
        n = n || ref(0)
        return { n }
      },
    })

    const Component = defineComponent({
      render: () => null,
      setup() {
        const store = useStore()
        store.n++
      },
    })

    const options = {
      global: {
        plugins: [pinia],
      },
    }

    let wrapper = mount(Component, options)
    await wrapper.unmount()

    expect(globalWatch).toHaveBeenCalledTimes(1)

    let store = useStore()
    store.n++
    await nextTick()
    expect(globalWatch).toHaveBeenCalledTimes(2)

    wrapper = mount(Component, options)
    await wrapper.unmount()

    expect(globalWatch).toHaveBeenCalledTimes(3)

    store = useStore()
    store.n++
    await nextTick()
    expect(globalWatch).toHaveBeenCalledTimes(4)

    destroy()
  })
})
