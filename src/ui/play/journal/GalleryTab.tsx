import { useState } from 'react';
import { Images, Settings } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { useImageList, useImageUrl, type StoredImageMeta } from '@/storage';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { EmptyState, Spinner } from '@/ui/components/ui';
import { IMAGE_SETTINGS_LINK, useImagesAvailability } from '../images/availability';
import { ImageLightbox } from '../images/ImageLightbox';

/** Every picture painted for this campaign, newest first. They live only in this browser. */
export function GalleryTab() {
  const campaignId = useGame((s) => s.campaignId);
  const images = useImageList(campaignId);
  const [openId, setOpenId] = useState<string | null>(null);

  if (images === undefined) {
    return (
      <div className="grid place-items-center py-8">
        <Spinner label="Loading the gallery" />
      </div>
    );
  }
  if (images.length === 0) return <EmptyGallery />;

  const index = images.findIndex((img) => img.id === openId);
  const open = index >= 0 ? images[index] : null;
  const step = (by: number) => setOpenId(images[(index + by + images.length) % images.length].id);

  return (
    <div className="@container flex flex-col gap-2">
      <p className="text-xs text-faint">
        {images.length === 1 ? '1 picture' : `${images.length} pictures`}, newest first. Kept in this browser only.
      </p>
      <ul className="grid grid-cols-2 gap-2 @xs:grid-cols-3 @xl:grid-cols-4" aria-label="Pictures">
        {images.map((image) => (
          <li key={image.id}>
            <Thumbnail image={image} onOpen={() => setOpenId(image.id)} />
          </li>
        ))}
      </ul>
      <ImageLightbox
        image={open}
        onClose={() => setOpenId(null)}
        navigation={open ? { position: index + 1, count: images.length, onPrevious: () => step(-1), onNext: () => step(1) } : undefined}
      />
    </div>
  );
}

function Thumbnail({ image, onOpen }: { image: StoredImageMeta; onOpen: () => void }) {
  const url = useImageUrl(image.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open picture: ${image.title}`}
      className="group flex w-full flex-col gap-1 rounded-lg text-left"
    >
      <span className="block aspect-square w-full overflow-hidden rounded-lg border border-border bg-surface-2">
        {url && (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        )}
      </span>
      <span className="line-clamp-2 text-xs leading-snug text-muted group-hover:text-text">{image.title}</span>
    </button>
  );
}

/** How pictures come to be, and how to turn them on when they can't be made yet. */
function EmptyGallery() {
  const availability = useImagesAvailability();
  const moments = useSettings((s) => s.images.frequency === 'moments');
  if (!availability.ok) {
    return (
      <EmptyState
        icon={<Images className="size-7" aria-hidden />}
        title="No pictures yet"
        className="py-8!"
        action={
          <ButtonLink
            to={IMAGE_SETTINGS_LINK}
            size="sm"
            icon={<Settings className="size-4" aria-hidden />}
            className="whitespace-nowrap"
          >
            Open Settings
          </ButtonLink>
        }
      >
        <p>The DM can paint scenes, people and creatures for you.</p>
        <p className="mt-1.5">{availability.reason}</p>
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<Images className="size-7" aria-hidden />} title="No pictures yet" className="py-8!">
      Ask the DM to show you a place, a person or a creature, or choose “Show me the scene” in the + menu.
      {moments && ' The DM also paints big moments as they happen.'} Every picture is kept here.
    </EmptyState>
  );
}
