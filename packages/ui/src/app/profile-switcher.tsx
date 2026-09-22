import { Button } from '@/components/ui/button';
import type { ProfileView } from '@/lib/daemon';
import { cn } from '@/lib/utils';

/**
 * Which network the console is pointed at.
 *
 * A row of buttons rather than a dropdown: there are three of them, the choice
 * changes what every other number on screen means, and a console that quietly
 * shows mainnet figures while a person believes they are on devnet is the one
 * mistake this control exists to prevent. An unconfigured profile is still
 * selectable — mainnet has no connector yet, and hiding it would be a worse
 * answer than a card that says so.
 */
export function ProfileSwitcher({
  profiles,
  switching,
  onSelect,
}: {
  profiles: readonly ProfileView[];
  switching?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Network profile"
      className="bg-muted inline-flex items-center gap-1 rounded-lg p-1"
    >
      {profiles.map((profile) => (
        <Button
          key={profile.id}
          type="button"
          size="sm"
          variant={profile.active ? 'default' : 'ghost'}
          aria-pressed={profile.active}
          disabled={switching !== undefined}
          title={profile.description}
          onClick={() => onSelect(profile.id)}
          className={cn(switching === profile.id && 'opacity-60')}
        >
          {profile.label}
          {!profile.configured && (
            <span className="text-[0.65rem] uppercase opacity-70">unconfigured</span>
          )}
        </Button>
      ))}
    </div>
  );
}
