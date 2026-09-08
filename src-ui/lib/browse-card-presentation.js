// Keep the title readable below the artwork, including on touch screens.
export function addBrowseCardCaption(card) {
  if (card.querySelector('.browse-card-caption')) return;
  const caption = document.createElement('div');
  caption.className = 'browse-card-caption';
  const title = document.createElement('p');
  title.className = 'browse-card-title';
  title.textContent = card.dataset.title || 'Untitled';
  caption.appendChild(title);
  if (!card.dataset.resumeSource) {
    const metadata = document.createElement('p');
    metadata.className = 'browse-card-meta';
    const type = card.dataset.runtime === 'Course' ? 'Course' : card.dataset.mediaType === 'tv' || card.dataset.seriesId ? 'Series' : 'Movie';
    metadata.textContent = [card.dataset.year, type].filter(Boolean).join(' · ');
    caption.appendChild(metadata);
  }
  card.querySelector('.card-base')?.after(caption);
  const hoverBody = card.querySelector('.card-hover-body');
  if (hoverBody) {
    const hoverTitle = title.cloneNode(true);
    hoverTitle.className = 'card-hover-title';
    hoverBody.prepend(hoverTitle);
  }
}
