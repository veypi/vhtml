export default async ($mod) => {
  console.log($mod)
  const res = await fetch(`${$mod.scoped}/langs.json`)
  const messages = await res.json()
  $mod.$i18n.load(messages)
}
