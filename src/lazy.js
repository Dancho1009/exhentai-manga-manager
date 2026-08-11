export const installLazyDirective = app => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const el = entry.target
      const enterCallback = el._lazyEnterCallback
      const leaveCallback = el._lazyLeaveCallback

      if (entry.isIntersecting) {
        if (typeof enterCallback === 'function') enterCallback(el._lazyArg)
      } else if (typeof leaveCallback === 'function') {
        leaveCallback(el._lazyArg)
      }
    })
  }, {
    rootMargin: '2560px'
  })

  app.directive('lazy', {
    mounted (el, binding) {
      el._lazyEnterCallback = binding.value.enter
      el._lazyLeaveCallback = binding.value.leave
      el._lazyArg = binding.arg
      observer.observe(el)
    },
    unmounted (el) {
      observer.unobserve(el)
      delete el._lazyEnterCallback
      delete el._lazyLeaveCallback
      delete el._lazyArg
    }
  })
}
