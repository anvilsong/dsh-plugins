import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('client registers the model-option switch', () => {
  const registrations = []
  const slots = {
    inject(name, callback) { callback() },
    register(definition, component) { registrations.push({ definition, component }) },
  }
  const context = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          const result = factory(() => ({}))
          assert.equal(id, 'dsh-plugin-advisor')
          assert.equal(result.inject[0], 'slots')
          result.apply({ get: () => undefined, slots, effect() {} })
        },
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].definition.name, 'conversation.input.model.options')
  assert.equal(registrations[0].definition.id, 'advisor-option')
})
