// Weergavenamen voor waarden die de detectie oplevert.
//
// Uit components/ui.tsx gehaald: een constante is geen component, en zolang
// hij daar stond herlaadde elke bewerking aan ui.tsx de hele pagina in plaats
// van alleen het component te verversen.

export const PRODUCT_LINE_LABEL: Record<string, string> = {
  hard_lemonade: 'Hard Lemonade',
  hard_seltzer: 'Hard Seltzer',
  hard_iced_tea: 'Hard Iced Tea',
  mixed_classics: 'Mixed Classics',
  logo_only: 'Logo only',
  zero_zero: 'Zero Zero',
}
