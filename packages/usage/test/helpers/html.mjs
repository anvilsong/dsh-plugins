/**
 * Serialize a fake-React tree (`{ type, props, children }`) to escaped static
 * HTML for the gallery.
 *
 *   className -> class, htmlFor -> for; a style object -> inline CSS
 *   role, aria-* and data-* are kept; ids, titles and form attributes from a
 *   short allow list are kept; everything else is dropped
 *   functions (event handlers), refs and keys are dropped
 *   a `portal` node (the harness's fake createPortal) writes its children in place
 *   text and attribute values are HTML-escaped
 *   no script (or other active/embedding) element is ever emitted: it throws
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'noscript'])
const BOOLEAN_ATTRIBUTES = new Set(['disabled', 'checked', 'selected', 'readonly', 'hidden', 'multiple', 'required'])
const ATTRIBUTE_ALIASES = { className: 'class', htmlFor: 'for', readOnly: 'readonly', tabIndex: 'tabindex', autoComplete: 'autocomplete', maxLength: 'maxlength' }
const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'title', 'type', 'value', 'placeholder', 'href', 'target', 'rel', 'name', 'role', 'alt', 'for',
  'tabindex', 'lang', 'dir', 'autocomplete', 'maxlength', ...BOOLEAN_ATTRIBUTES,
])
const UNITLESS_STYLES = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'lineHeight', 'fontWeight', 'order', 'zoom'])
const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/(?!\/))/i

/** Host primitives the client renders by name: mapped to plain elements. */
export const DEFAULT_COMPONENTS = {
  Button: (props) => ({
    tag: 'button',
    attributes: {
      class: 'dsw-primitive',
      'data-primitive': 'Button',
      'data-variant': props.variant,
      'data-size': props.size,
      type: props.type ?? 'button',
      disabled: props.disabled,
    },
  }),
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function kebab(name) {
  if (name.startsWith('--')) return name
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** A style object as inline CSS text (unescaped). */
export function styleText(style) {
  if (typeof style === 'string') return style
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [name, value] of Object.entries(style)) {
    if (value === null || value === undefined || value === false || value === true || value === '') continue
    let text
    if (typeof value === 'number') {
      text = value === 0 || UNITLESS_STYLES.has(name) || name.startsWith('--') ? String(value) : `${value}px`
    } else {
      text = String(value)
    }
    parts.push(`${kebab(name)}:${text}`)
  }
  return parts.join(';')
}

function attributeName(raw) {
  if (raw === 'key' || raw === 'ref' || raw === 'children') return null
  if (raw === 'dangerouslySetInnerHTML') throw new Error('dangerouslySetInnerHTML is not allowed in the gallery')
  if (raw.startsWith('aria-') || raw.startsWith('data-')) return /^[a-z][a-z0-9-]*$/.test(raw) ? raw : null
  const name = ATTRIBUTE_ALIASES[raw] ?? raw
  return ALLOWED_ATTRIBUTES.has(name) ? name : null
}

function attributesText(attributes, skip = new Set()) {
  let out = ''
  for (const [raw, value] of Object.entries(attributes)) {
    if (skip.has(raw) || typeof value === 'function') continue
    if (raw === 'style') {
      const css = styleText(value)
      if (css) out += ` style="${escapeHtml(css)}"`
      continue
    }
    const name = attributeName(raw)
    if (!name || value === null || value === undefined || value === false) continue
    if (typeof value === 'object') continue
    if (BOOLEAN_ATTRIBUTES.has(name)) {
      if (value === true) out += ` ${name}`
      continue
    }
    if (typeof value === 'boolean') continue
    if (name === 'href' && !SAFE_HREF.test(String(value))) continue
    out += ` ${name}="${escapeHtml(value)}"`
  }
  return out
}

function renderChildren(children, context) {
  if (Array.isArray(children)) return children.map((child) => renderNode(child, context)).join('')
  return renderNode(children, context)
}

function renderNode(node, context) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return escapeHtml(node)
  if (Array.isArray(node)) return renderChildren(node, context)
  if (typeof node !== 'object' || !('type' in node)) {
    throw new Error('the tree holds a value that is neither text nor an element')
  }
  let { type } = node
  const props = node.props ?? {}
  if (typeof type === 'function') throw new Error('the tree still holds an unrendered component')
  if (typeof type !== 'string') throw new Error('an element type must be a string')
  if (type === 'fragment') return renderChildren(node.children, context)
  // The fake createPortal (client-harness.mjs): a static page has no body to
  // portal into, so the content is written in place.
  if (type === 'portal') return renderChildren(node.children, context)

  let attributes = props
  if (/^[A-Z]/.test(type)) {
    const component = context.components[type]
    if (!component) throw new Error(`no serializer mapping for component ${type}`)
    const mapped = component(props)
    type = mapped.tag
    attributes = mapped.attributes
  }
  if (!/^[a-z][a-z0-9]*$/.test(type)) throw new Error(`bad tag name ${JSON.stringify(type)}`)
  if (FORBIDDEN_TAGS.has(type)) throw new Error(`the ${type} element is not allowed in the gallery`)

  // A controlled select marks its matching option instead of carrying a value.
  let childContext = context
  let open = `<${type}${attributesText(attributes, type === 'select' || type === 'textarea' ? new Set(['value']) : undefined)}`
  if (type === 'select') childContext = { ...context, selectValue: props.value }
  if (type === 'option' && context.selectValue !== undefined && String(props.value) === String(context.selectValue)) {
    open += ' selected'
  }
  if (VOID_TAGS.has(type)) return `${open}>`
  if (type === 'textarea') return `${open}>${escapeHtml(props.value ?? '')}</${type}>`
  return `${open}>${renderChildren(node.children, childContext)}</${type}>`
}

/** Serialize a tree to escaped static HTML. */
export function toHtml(tree, { components = {} } = {}) {
  return renderNode(tree, { components: { ...DEFAULT_COMPONENTS, ...components }, selectValue: undefined })
}
