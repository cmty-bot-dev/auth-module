import getProp from 'dotprop'

import Storage from './storage'
import { routeOption, isRelativeURL, isUnset, isSameURL } from './utilities'

export default class Auth {
  constructor (ctx, options) {
    this.ctx = ctx
    this.options = options

    // Strategies
    this.strategies = {}

    // Error listeners
    this._errorListeners = []

    // Storage & State
    options.initialState = { user: null, loggedIn: false }
    const storage = new Storage(ctx, options)

    this.$storage = storage
    this.$state = storage.state
  }

  init () {
    // Watch for loggedIn changes only in client side
    if (process.browser) {
      this.$storage.watchState('loggedIn', loggedIn => {
        if (!routeOption(this.ctx.route, 'auth', false)) {
          this.redirect(loggedIn ? 'home' : 'logout')
        }
      })
    }

    // Restore strategy
    this.$storage.syncUniversal('strategy', this.options.defaultStrategy)

    // Call mounted for active strategy on initial load
    return this.mounted()
  }

  // Backward compatibility
  get state () {
    if (!this._state_warn_shown) {
      this._state_warn_shown = true
      // eslint-disable-next-line no-console
      console.warn('[AUTH] $auth.state is deprecated. Please use $auth.$state or top level props like $auth.loggedIn')
    }

    return this.$state
  }

  getState (key) {
    if (!this._get_state_warn_shown) {
      this._get_state_warn_shown = true
      // eslint-disable-next-line no-console
      console.warn('[AUTH] $auth.getState is deprecated. Please use $auth.$storage.getState() or top level props like $auth.loggedIn')
    }

    return this.$storage.getState(key)
  }

  // ---------------------------------------------------------------
  // Strategy and Scheme
  // ---------------------------------------------------------------

  get strategy () {
    return this.strategies[this.$state.strategy]
  }

  registerStrategy (name, strategy) {
    this.strategies[name] = strategy
  }

  setStrategy (name) {
    if (name === this.$storage.getUniversal('strategy')) {
      return Promise.resolve()
    }

    // Set strategy
    this.$storage.setUniversal('strategy', name)

    // Call mounted hook on active strategy
    return this.mounted()
  }

  mounted () {
    if (!this.strategy.mounted) {
      return this.fetchUserOnce()
    }

    return Promise.resolve(this.strategy.mounted(...arguments)).catch(error =>
      this.callOnError(error, { method: 'mounted' })
    )
  }

  loginWith (name, ...args) {
    return this.setStrategy(name).then(() => this.login(...args))
  }

  login () {
    if (!this.strategy.login) {
      return Promise.resolve()
    }

    return this.wrapLogin(this.strategy.login(...arguments)).catch(error =>
      this.callOnError(error, { method: 'login' })
    )
  }

  fetchUser () {
    if (!this.strategy.fetchUser) {
      return Promise.resolve()
    }

    return Promise.resolve(this.strategy.fetchUser(...arguments)).catch(error =>
      this.callOnError(error, { method: 'fetchUser' })
    )
  }

  logout () {
    if (!this.strategy.logout) {
      this.reset()
      return Promise.resolve()
    }

    return Promise.resolve(this.strategy.logout(...arguments)).catch(error =>
      this.callOnError(error, { method: 'logout' })
    )
  }

  reset () {
    if (!this.strategy.reset) {
      this.setUser(null)
      this.setToken(this.$state.strategy, null)
      return Promise.resolve()
    }

    return Promise.resolve(this.strategy.reset(...arguments)).catch(error =>
      this.callOnError(error, { method: 'reset' })
    )
  }

  // ---------------------------------------------------------------
  // Token helpers
  // ---------------------------------------------------------------

  getToken (strategy) {
    const _key = this.options.token.prefix + strategy

    return this.$storage.getUniversal(_key)
  }

  setToken (strategy, token) {
    const _key = this.options.token.prefix + strategy

    return this.$storage.setUniversal(_key, token)
  }

  syncToken (strategy) {
    const _key = this.options.token.prefix + strategy

    return this.$storage.syncUniversal(_key)
  }

  // ---------------------------------------------------------------
  // User helpers
  // ---------------------------------------------------------------

  get user () {
    return this.$state.user
  }

  get loggedIn () {
    return this.$state.loggedIn
  }

  fetchUserOnce () {
    if (!this.$state.user) {
      return this.fetchUser(...arguments)
    }
    return Promise.resolve()
  }

  setUser (user) {
    this.$storage.setState('loggedIn', Boolean(user))
    this.$storage.setState('user', user)
  }

  // ---------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------

  get busy () {
    return this.$storage.getState('busy')
  }

  request (endpoint, defaults) {
    const _endpoint =
      typeof defaults === 'object'
        ? Object.assign({}, defaults, endpoint)
        : endpoint

    return this.ctx.app.$axios
      .request(_endpoint)
      .then(response => {
        if (_endpoint.propertyName) {
          return getProp(response.data, _endpoint.propertyName)
        } else {
          return response.data
        }
      })
      .catch(error => {
        // Call all error handlers
        this.callOnError(error, { method: 'request' })

        // Throw error
        return Promise.reject(error)
      })
  }

  requestWith (strategy, endpoint, defaults) {
    const token = this.getToken(strategy)

    if (isUnset(token)) {
      return Promise.reject(new Error('No Token'))
    }

    const _endpoint = Object.assign({}, defaults, endpoint)

    if (!_endpoint.headers) {
      _endpoint.headers = {}
    }

    if (!_endpoint.headers['Authorization']) {
      _endpoint.headers['Authorization'] = token
    }

    return this.request(_endpoint)
  }

  wrapLogin (promise) {
    this.$storage.setState('busy', true)
    this.error = null

    return Promise.resolve(promise)
      .then(() => {
        this.$storage.setState('busy', false)
      })
      .catch(error => {
        this.$storage.setState('busy', false)
        return Promise.reject(error)
      })
  }

  onError (listener) {
    this._errorListeners.push(listener)
  }

  callOnError (error, payload = {}) {
    this.error = error

    for (let fn of this._errorListeners) {
      fn(error, payload)
    }
  }

  redirect (name, noRouter = false) {
    if (!this.options.redirect) {
      return
    }

    const from = this.options.fullPathRedirect ? this.ctx.route.path : this.ctx.route.fullPath

    let to = this.options.redirect[name]
    if (!to) {
      return
    }

    // Apply rewrites
    if (this.options.rewriteRedirects) {
      if (name === 'login' && isRelativeURL(from) && !isSameURL(to, from)) {
        this.$storage.setUniversal('redirect', from)
      }

      if (name === 'home') {
        const redirect = this.$storage.getUniversal('redirect')
        this.$storage.setUniversal('redirect', null)

        if (isRelativeURL(redirect)) {
          to = redirect
        }
      }
    }

    // Prevent infinity redirects
    if (isSameURL(to, from)) {
      return
    }

    if (process.browser) {
      if (noRouter) {
        window.location.replace(to)
      } else {
        this.ctx.redirect(to)
      }
    } else {
      this.ctx.redirect(to)
    }
  }

  hasScope (scope) {
    const userScopes = this.$state.user && getProp(this.$state.user, this.options.scopeKey)

    if (!userScopes) {
      return undefined
    }

    if (Array.isArray(userScopes)) {
      return userScopes.includes(scope)
    }

    return Boolean(getProp(userScopes, scope))
  }
}
