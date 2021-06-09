import {
  watch,
  computed,
  Ref,
  inject,
  getCurrentInstance,
  reactive,
  onUnmounted,
  InjectionKey,
  provide,
  DebuggerEvent,
  WatchOptions,
  UnwrapRef,
  markRaw,
  isRef,
  isReactive,
} from 'vue'
import {
  StateTree,
  StoreWithState,
  SubscriptionCallback,
  DeepPartial,
  isPlainObject,
  StoreWithGetters,
  Store,
  StoreWithActions,
  _Method,
  StateDescriptor,
  DefineStoreOptions,
  StoreDefinition,
  GettersTree,
  MutationType,
  StoreOnActionListener,
  UnwrapPromise,
  ActionsTree,
  SubscriptionCallbackMutation,
} from './types'
import {
  getActivePinia,
  setActivePinia,
  storesMap,
  piniaSymbol,
  Pinia,
} from './rootStore'
import { IS_CLIENT } from './env'

//  使用一个对象(patchToApply) 中的属性更新另外一个对象(target)的属性
// 调用$patch时调用此函数, 将传入的要更新的字段(patchToApply)更新到store(target)
function innerPatch<T extends StateTree>(
  target: T,
  patchToApply: DeepPartial<T>
): T {
  // TODO: get all keys like symbols as well
  for (const key in patchToApply) {
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      target[key] = innerPatch(targetValue, subPatch)
    } else {
      // @ts-ignore
      target[key] = subPatch
    }
  }

  return target
}

const { assign } = Object

/**
 * Create an object of computed properties referring to
 *
 * @param rootStateRef - pinia.state
 * @param id - unique name
 */
//  将所有state使用computed()进行包装
function computedFromState<T, Id extends string>(
  rootStateRef: Ref<Record<Id, T>>,
  id: Id
) {
  // let asComputed = computed<T>()
  const reactiveObject = {} as {
    [k in keyof T]: Ref<T[k]>
  }
  const state = rootStateRef.value[id]
  for (const key in state) {
    // @ts-expect-error: the key matches
    reactiveObject[key] = computed({
      get: () => rootStateRef.value[id][key as keyof T],
      set: (value) => (rootStateRef.value[id][key as keyof T] = value),
    })
  }

  return reactiveObject
}

/**
 * Creates a store with its state object. This is meant to be augmented with getters and actions
 *
 * @param id - unique identifier of the store, like a name. eg: main, cart, user
 * @param buildState - function to build the initial state
 * @param initialState - initial state applied to the store, Must be correctly typed to infer typings
 */
//  初始化缓存信息,第一次调用store时,由于没有缓存数据,会调用此函数进行初始化缓存信息
function initStore<
  Id extends string,
  S extends StateTree,
  G extends GettersTree<S>,
  A /* extends ActionsTree */
>(
  $id: Id,
  buildState: () => S = () => ({} as S),
  initialState?: S | undefined
): [
  StoreWithState<Id, S, G, A>,
  { get: () => S; set: (newValue: S) => void },
  InjectionKey<Store>
] {
  //  获取当前使用的pinia实例
  const pinia = getActivePinia()
  //  将当前store定义的state缓存到pinia实例中的state下 
  //  如果具有initialState (pinia.state.value[id]) 就使用initialState
  //  如果没有initialState 则使用 buildState() 配置的state
  pinia.state.value[$id] = initialState || buildState()
  // const state: Ref<S> = toRef(_p.state.value, $id)

  //  判断当前是否为监听状态,  
  //  在每一个$subscribe内部都使用了watch()监听state数据变化,当state更新后,触发watch(), 在isListening === true 时,会调用$subscribe 传入的回调事件
  //  但是state更新具有三种方式  1.直接state赋值 2.使用$patch 3. $state更新所有state
  //  当使用$patch改变state时,会主动调用了subscription, 设置属于$patch的MutationType类型 ,所以在$patch更新前,会将此isListening设置为false,以取消watch()中的触发subscriptions, 并在更新完毕后重新赋值 isListening = true
  //  当使用$state 更新state时也会 将 isListening 设置为false

  //  估计主要是为了区分使用什么方式更新 ,回调事件中具有 MutationType 值代表使用哪种方式更新
  let isListening = true

  //  state更新数据的订阅者,当state数据更新时,会触发所有订阅
  //  使用 $subscribe 来添加订阅者
  let subscriptions: SubscriptionCallback<S>[] = markRaw([])

  //  action被调用触发的订阅者, 当action被调用后, 触发所有订阅
  //  使用 $onAction 添加订阅者
  // 最后会将所有订阅者存放在 store._as 属性中,在某个action时, 触发所有订阅
  let actionSubscriptions: StoreOnActionListener<Id, S, G, A>[] = markRaw([])
  let debuggerEvents: DebuggerEvent[] | DebuggerEvent

  //  调用$patch更新state
  //  使用$patch 更新state具有两种写法 
  //  1.  $patch((state) => state.a = 1);
  //  2.  $patch({ a: 1 });
  //  调用$patch会将isListening设置为false, 并且主动触发subscriptions,
  function $patch(stateMutation: (state: UnwrapRef<S>) => void): void
  function $patch(partialState: DeepPartial<UnwrapRef<S>>): void
  function $patch(
    partialStateOrMutator:
      | DeepPartial<UnwrapRef<S>>
      | ((state: UnwrapRef<S>) => void)
  ): void {
    let subscriptionMutation: SubscriptionCallbackMutation<S>
    //  取消本次 watch() 中触发 订阅信息
    isListening = false
    // reset the debugger events since patches are sync
    /* istanbul ignore else */
    if (__DEV__) {
      debuggerEvents = []
    }
    if (typeof partialStateOrMutator === 'function') {
      // 如果$patch参数传入的为函数,将store.state作为参数传递调用函数
      partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>)
      subscriptionMutation = {
        type: MutationType.patchFunction,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    } else {
      //  $patch参数传递是为对象,那么使用对象中的字段对store.state进行更新
      //  `innerPatch 就是使用一个对象,对另一个对象中的某些属性进行更新
      innerPatch(pinia.state.value[$id], partialStateOrMutator)
      subscriptionMutation = {
        type: MutationType.patchObject,
        payload: partialStateOrMutator,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    }
    //  重新启动监听状态
    isListening = true
    // because we paused the watcher, we need to manually call the subscriptions
    //  主动触发订阅信息
    subscriptions.forEach((callback) => {
      callback(subscriptionMutation, pinia.state.value[$id] as UnwrapRef<S>)
    })
  }

  //  state更新触发回调事件
  function $subscribe(callback: SubscriptionCallback<S>) {
    //  将当前订阅信息进行缓存,用于使用$patch更新数据时的群发订阅操作
    subscriptions.push(callback)

    // watch here to link the subscription to the current active instance
    // e.g. inside the setup of a component
    const options: WatchOptions = { deep: true, flush: 'sync' }
    /* istanbul ignore else */
    if (__DEV__) {
      options.onTrigger = (event) => {
        if (isListening) {
          debuggerEvents = event
        } else {
          // let patch send all the events together later
          /* istanbul ignore else */
          if (Array.isArray(debuggerEvents)) {
            debuggerEvents.push(event)
          } else {
            console.error(
              '🍍 debuggerEvents should be an array. This is most likely an internal Pinia bug.'
            )
          }
        }
      }
    }
    //  使用vue watch监听state数据变化
    const stopWatcher = watch(
      () => pinia.state.value[$id] as UnwrapRef<S>,
      (state, oldState) => {
        if (isListening) {
          callback(
            {
              storeId: $id,
              type: MutationType.direct,
              events: debuggerEvents as DebuggerEvent,
            },
            state
          )
        }
      },
      options
    )

    const removeSubscription = () => {
      //  移除回调事件
      const idx = subscriptions.indexOf(callback)
      if (idx > -1) {
        subscriptions.splice(idx, 1)
        stopWatcher()
      }
    }

    if (getCurrentInstance()) {
      //  如果是在setup中,会使用onUnmounted钩子移除回调事件
      //  所以在setup中允许不主动移除回调
      onUnmounted(removeSubscription)
    }

    return removeSubscription
  }

  //  定义$onAction事件, 将定义的此事件存放在 store._as中
  //  然后触发action时调用 ..触发action 定义在 buildStoreToUse().wrappedActions中
  function $onAction(callback: StoreOnActionListener<Id, S, G, A>) {
     //  将当前订阅信息进行缓存,用于调用action时群发订阅操作
    actionSubscriptions.push(callback)

    const removeSubscription = () => {
      const idx = actionSubscriptions.indexOf(callback)
      if (idx > -1) {
        actionSubscriptions.splice(idx, 1)
      }
    }

    if (getCurrentInstance()) {
     //  如果是在setup中,会使用onUnmounted钩子移除回调事件
      //  所以在setup中允许不主动移除回调
      onUnmounted(removeSubscription)
    }

    return removeSubscription
  }

  //  重置state数据
  function $reset() {
    // 将state数据重置为最开始配置的数据
    pinia.state.value[$id] = buildState()
  }

  const storeWithState: StoreWithState<Id, S, G, A> = {
    $id,
    _p: pinia,
    _as: actionSubscriptions as unknown as StoreOnActionListener[],

    // $state is added underneath

    $patch,
    $subscribe,
    $onAction,
    $reset,
  } as StoreWithState<Id, S, G, A>

  // 定义当前store的标志,使用id
  const injectionSymbol = __DEV__
    ? Symbol(`PiniaStore(${$id})`)
    : /* istanbul ignore next */
      Symbol()

  return [
    storeWithState,
    {
      // StateDescriptor<S> 类型, 此实例可以直接更新所有state值，
      //  这个对象也就是使用$state更新state时调用的对象
      //  在buildStoreToUse() 函数会将此对象设置到store.$state上
      get: () => pinia.state.value[$id] as S,
      set: (newState: S) => {
        isListening = false
        pinia.state.value[$id] = newState
        isListening = true
      },
    },
    //  当前store的标志
    injectionSymbol,
  ]
}

const noop = () => {}
/**
 * Creates a store bound to the lifespan of where the function is called. This
 * means creating the store inside of a component's setup will bound it to the
 * lifespan of that component while creating it outside of a component will
 * create an ever living store
 *
 * @param partialStore - store with state returned by initStore
 * @param descriptor - descriptor to setup $state property
 * @param $id - unique name of the store
 * @param getters - getters of the store
 * @param actions - actions of the store
 */
//  创建一个与调用者函数生命周期绑定的存储对象
function buildStoreToUse<
  Id extends string,
  S extends StateTree,
  G extends GettersTree<S>,
  A extends ActionsTree
>(
  partialStore: StoreWithState<Id, S, G, A>,
  descriptor: StateDescriptor<S>,
  $id: Id,
  getters: G = {} as G,
  actions: A = {} as A,
  options: DefineStoreOptions<Id, S, G, A>
) {
  // 获取当前正在使用的pinia实例
  const pinia = getActivePinia()

  // 将所有getter进行包装, 将所有的getter都使用computed()进行包装监听
  const computedGetters: StoreWithGetters<G> = {} as StoreWithGetters<G>
  for (const getterName in getters) {
    //  遍历所有getter,将每一个getter都使用computed()函数进行包装计算
    // @ts-ignore: it's only readonly for the users
    computedGetters[getterName] = computed(() => {
      // 重新执行计算时,设置当前使用pinia实例,防止当前pinia实例不是配置时的pinia实例
      setActivePinia(pinia)
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      // @ts-expect-error: the argument count is correct
      //  将getters的调用权给store, 并且第一个参数设置为当前store
      //  所以在getter中可以使用this 或者第一个参数访问store
      //  注意: 使用this仅可以在非箭头函数下, 而使用第一个参数访问, 箭头函数普通函数均可
      return getters[getterName].call(store, store)
    }) as StoreWithGetters<G>[typeof getterName]
  }

  //  对所有action进行包装, 用于触发调用action订阅事件
  const wrappedActions: StoreWithActions<A> = {} as StoreWithActions<A>
  for (const actionName in actions) {
    wrappedActions[actionName] = function (this: Store<Id, S, G, A>) {
      setActivePinia(pinia)
      const args = Array.from(arguments) as Parameters<A[typeof actionName]>
      const localStore = this || store

      //  设置函数调用的回调函数
      //   这一块逻辑有些绕
      //   首先定义两个函数  after 和 onError
      //  这两个参数分别为 afterCallback(执行成功的回调) 和 onErrorCallback(执行失败的回调)
      //  然后调用所有 $onAction() 的订阅者, 将  after 和 onError 函数 传递给$onAction()的订阅者. 获取由订阅者传入回调函数
      //  最后使用Promise.resolve() 包装真正的方法并执行
      //   $onAction(
      //     ({ name, store, args, after, onError }) => {
      //         after((result: any) => {
      //              这是action执行成功的回调
      //              这个回调就是 afterCallback 引用的函数
      //         });
      //         onError((error: any) => {
      //              这是action执行失败的回调
      //              这个回调就是 onErrorCallback 引用的函数
      //         });
      //     }
      // );

      //  注意: 【相同store】 【相同vue组件】 只会执行最后一个 afterCallback 、onErrorCallback 
      //       【相同store】 【不同vue组件】 都会执行 afterCallback 、onErrorCallback
      //       【不同store】 【相同vue组件】 都会执行 afterCallback、onErrorCallback

      let afterCallback: (
        resolvedReturn: UnwrapPromise<ReturnType<A[typeof actionName]>>
      ) => void = noop
      let onErrorCallback: (error: unknown) => void = noop
      function after(callback: typeof afterCallback) {
        afterCallback = callback
      }
      function onError(callback: typeof onErrorCallback) {
        onErrorCallback = callback
      }

      //  通知订阅者
      partialStore._as.forEach((callback) => {
        // @ts-expect-error
        callback({ args, name: actionName, store: localStore, after, onError })
      })

      let ret: ReturnType<A[typeof actionName]>
      try {
        ret = actions[actionName].apply(localStore, args as unknown as any[])
        Promise.resolve(ret).then(afterCallback).catch(onErrorCallback)
      } catch (error) {
        onErrorCallback(error)
        throw error
      }

      return ret
    } as StoreWithActions<A>[typeof actionName]
  }

  const store: Store<Id, S, G, A> = reactive(
    //  将所有state、getter、action 组装成object
    assign(
      {},
      partialStore,
      // using this means no new properties can be added as state
      // 将当前store中的所有state使用computed()包装，变成可相应的
      computedFromState(pinia.state, $id),
      computedGetters,
      wrappedActions
    )
  ) as Store<Id, S, G, A>

  // use this instead of a computed with setter to be able to create it anywhere
  // without linking the computed lifespan to wherever the store is first
  // created.
  // 将 
  // get: () => pinia.state.value[$id] as S,
  // set: (newState: S) => {
  //   isListening = false
  //   pinia.state.value[$id] = newState
  //   isListening = true
  // },
  //  赋值到store.$state中
  Object.defineProperty(store, '$state', descriptor)

  // add getters for devtools
  if (__DEV__ && IS_CLIENT) {
    store._getters = markRaw(Object.keys(getters))
  }

  //  调用所有插件
  //  所有，每生成一个store后，会调用所有的插件
  // apply all plugins
  pinia._p.forEach((extender) => {
    // @ts-expect-error: conflict between A and ActionsTree
    assign(store, extender({ store, app: pinia._a, pinia, options }))
  })

  return store
}

/**
 * Creates a `useStore` function that retrieves the store instance
 * @param options - options to define the store
 */
//  定义store
export function defineStore<
  Id extends string,
  S extends StateTree,
  G extends GettersTree<S>,
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */
>(options: DefineStoreOptions<Id, S, G, A>): StoreDefinition<Id, S, G, A> {
  //  获取传入的数据
  const { id, state, getters, actions } = options

  function useStore(pinia?: Pinia | null): Store<Id, S, G, A> {
    //  获取当前vue实例,
    //  如果没有传入pinia实例,则根据此vue实例从inject获取pinia实例
    const currentInstance = getCurrentInstance()
    // only run provide when pinia hasn't been manually passed
    //  当前变量代表如果具有vue实例,并且不是主动传入pinia, 那么会将当前store添加到provide中,允许子组件使用
    const shouldProvide = currentInstance && !pinia
    // avoid injecting if `useStore` when not possible
    pinia = pinia || (currentInstance && inject(piniaSymbol))
    //  设置当前pinia实例
    if (pinia) setActivePinia(pinia)
    // TODO: worth warning on server if no piniaKey as it can leak data
    pinia = getActivePinia()
    // 从storesMap中获取当前pinia存储的所有stores信息,如果不存在,则定义一个空map
    let stores = storesMap.get(pinia)
    if (!stores) storesMap.set(pinia, (stores = new Map()))

    //  根据id 获取当前store的state缓存和描述信息,如果当前store的state缓存和描述信息为空,就使用 配置的state进行初始化
    let storeAndDescriptor = stores.get(id) as
      | [
          StoreWithState<Id, S, G, A>,
          StateDescriptor<S>,
          InjectionKey<Store<Id, S, G, A>>
        ]
      | undefined

    let store: Store<Id, S, G, A>

    // 如果没有storeAndDescriptor(第一次调用),那么当前store的state数据和描述信息并没有被缓存,需要进行初始化
    if (!storeAndDescriptor) {
      //  initStore传递的三个参数为  1.当前配置的id  2.当前配置的state  3.缓存在pinia.state中的当前state信息  pinia.state使用了ref()进行包装
      //  pinia.state.value[id] 是在 initStore函数 赋值的
      // 如果为第一次调用initStore 时, state不为null, pinia.state.value[id]  
      //  在initStore()中将state赋值给  pinia.state.value[id] , 而之后 pinia.state.value[id]不为null, 
      //  则 pinia.state.value[id] = pinia.state.value[id]
      storeAndDescriptor = initStore(id, state, pinia.state.value[id])

      // @ts-expect-error: annoying to type
      stores.set(id, storeAndDescriptor)

      store = buildStoreToUse<
        Id,
        S,
        G,
        // @ts-expect-error: A without extends
        A
      >(
        storeAndDescriptor[0],
        storeAndDescriptor[1],
        id,
        getters,
        actions,
        options
      )

      // allow children to reuse this store instance to avoid creating a new
      // store for each child
      //  如果没有传入pinia实例,则根据此vue实例从inject获取pinia实例
      if (shouldProvide) {
        provide(storeAndDescriptor[2], store)
      }
    } else {

      store =
        (currentInstance && inject(storeAndDescriptor[2], null)) ||
        buildStoreToUse<
          Id,
          S,
          G,
          // @ts-expect-error: cannot extends ActionsTree
          A
        >(
          storeAndDescriptor[0],
          storeAndDescriptor[1],
          id,
          getters,
          actions,
          options
        )
    }

    // save stores in instances to access them devtools
    if (__DEV__ && IS_CLIENT && currentInstance && currentInstance.proxy) {
      const vm = currentInstance.proxy
      const cache = '_pStores' in vm ? vm._pStores! : (vm._pStores = {})
      // @ts-expect-error: still can't cast Store with generics to Store
      cache[store.$id] = store
    }

    return store
  }

  // needed by map helpers
  useStore.$id = id

  return useStore
}
