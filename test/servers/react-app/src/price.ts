// Traceable logic for the React tier (plain .ts → clean source map). priceFor is the original single-item
// demo; displayTotal is the checkout cart total — with a planted bug.

const DISCOUNTS: Record<string, number> = { SAVE10: 0.10, HALF: 0.5 };

export function priceFor(qty: number, unit: number, code: string) {
  const subtotal = qty * unit;
  const rate = DISCOUNTS[code] ?? 0;
  const total = subtotal * (1 - rate);            // ← breakpoint target
  return { subtotal, rate, total: Math.round(total * 100) / 100 };
}

export interface Line { sku: string; qty: number; lineTotal: number; }

// displayTotal(items): BUG — parseInt truncates each line to whole dollars, so the cart total shown to the
// user is short by all the cents. Breakpoint the accumulator line and watch `sum` go wrong per item.
export function displayTotal(items: Line[]) {
  let sum = 0;
  for (const it of items) {
    sum = sum + parseInt(String(it.lineTotal));    // BUG: drops the cents (19.98 → 19)
  }
  return sum;
}
