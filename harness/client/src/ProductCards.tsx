import type { ProductOption } from './productOptions'

/** Attributes worth a chip, in display order -- the rest (unit counts, age ranges) are noise
 * on a card. */
const CHIP_ATTRIBUTES = ['color', 'size', 'material', 'finish', 'style', 'scent', 'form', 'variety']
const MAX_ATTRIBUTE_CHIPS = 3

function formatPrice(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
}

/** "mall-wart" -> "Mall-Wart": readable without the client needing merchants.json. */
function merchantLabel(id: string): string {
  return id.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase())
}

/** What clicking a tile sends: a normal chat message naming the exact product and merchant,
 * so the agent opens checkout and confirms the total before paying -- the click doesn't pay. */
function buyMessage(option: ProductOption): string {
  const merchant = option.merchantIds[0]
  return `I'd like to buy the ${option.product.name}${merchant ? ` from ${merchantLabel(merchant)}` : ''} (product id ${option.product.id}).`
}

function ProductCard({
  option,
  onBuy,
  disabled,
}: {
  option: ProductOption
  onBuy?: (message: string) => void
  disabled?: boolean
}) {
  const { product } = option
  const attributeChips = CHIP_ATTRIBUTES.flatMap((key) => {
    const value = product.attributes?.[key]
    return value ? [value] : []
  }).slice(0, MAX_ATTRIBUTE_CHIPS)

  return (
    <button
      type="button"
      className={`product-card${option.topPick ? ' product-card-top' : ''}`}
      disabled={disabled || !onBuy}
      onClick={() => onBuy?.(buyMessage(option))}
      title={`Buy ${option.product.name}`}
    >
      <div className="product-image">
        {product.image_url ? (
          <img src={product.image_url} alt={product.name} loading="lazy" />
        ) : (
          <span className="product-image-empty">No photo</span>
        )}
        <span className="product-rank">{option.optionNumber}</span>
        {option.topPick && <span className="product-top-badge">Top pick</span>}
      </div>

      <div className="product-body">
        <div className="product-price">{formatPrice(option.priceCents, product.currency)}</div>
        <span className="product-name" title={product.name}>
          {product.name}
        </span>
        {product.brand && <div className="product-brand">{product.brand}</div>}

        <div className="product-chips">
          {option.merchantIds.map((id) => (
            <span key={id} className="chip chip-merchant">
              {merchantLabel(id)}
            </span>
          ))}
          {attributeChips.map((value) => (
            <span key={value} className="chip" title={value}>
              {value}
            </span>
          ))}
        </div>

        {option.why && <span className="product-why">{option.why}</span>}
        {option.tradeoff && (
          <span className="product-tradeoff">
            <span>Tradeoff</span> {option.tradeoff}
          </span>
        )}
        <span className="product-buy">Buy this</span>
      </div>
    </button>
  )
}

export function ProductCards({
  options,
  onBuy,
  disabled,
}: {
  options: ProductOption[]
  onBuy?: (message: string) => void
  disabled?: boolean
}) {
  return (
    <div className="product-cards">
      {options.map((option) => (
        <ProductCard key={option.product.id} option={option} onBuy={onBuy} disabled={disabled} />
      ))}
    </div>
  )
}
