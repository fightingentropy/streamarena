export default function BrandWordmark(props) {
  return <span class={`brand-wordmark${props.class ? ` ${props.class}` : ''}`} role="img" aria-label="StreamArena">
    Stream<span class="brand-wordmark-accent">Arena</span>
  </span>;
}
