import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DirectoryFilters } from '@/lib/daemon';

/**
 * The five filters §4.4's label vocabulary defines.
 *
 * Plain selects and checkboxes, because the values are a closed vocabulary and
 * the whole point of it is that `shared-kernel` means the same thing on every
 * provider — a free-text box would invite the one thing the vocabulary exists
 * to prevent. The only open value is a capability, which may be an `x-` name
 * the spec has not specified yet.
 *
 * `hidden` is three-valued and the wording says which is which: a Hidden
 * Provider is ordinary compute whose location is not published, not a warning.
 */

const ISOLATIONS = [
  { value: '', label: 'Any isolation' },
  { value: 'shared-kernel', label: 'Shared kernel' },
  { value: 'dedicated-host', label: 'Dedicated host' },
];

const ARCHITECTURES = [
  { value: '', label: 'Any arch' },
  { value: 'amd64', label: 'amd64' },
  { value: 'arm64', label: 'arm64' },
];

const HIDDEN = [
  { value: '', label: 'Hidden and public' },
  { value: 'false', label: 'Public only' },
  { value: 'true', label: 'Hidden only' },
];

/** §4.4 has specified these two. Anything else a Listing grants is shown as it came. */
const CAPABILITIES = ['docker', 'nesting'];

export function DirectoryFilterBar({
  filters,
  gpuModels,
  onChange,
  disabled,
}: {
  filters: DirectoryFilters;
  /**
   * The GPU models this network is actually selling, off the wire. `<model>`
   * is an open set (§4.4), so a list of card names baked into the console
   * would be a guess that goes stale the day a provider buys a newer one.
   */
  gpuModels: string[];
  onChange: (filters: DirectoryFilters) => void;
  disabled?: boolean;
}) {
  const gpus = [
    { value: '', label: 'GPU: any or none' },
    { value: 'any', label: 'Has a GPU' },
    ...gpuModels.map((model) => ({ value: model, label: model })),
  ];

  // A cleared control drops out of the filter set entirely rather than going
  // to the daemon as an empty string: "any arch" is the absence of a filter,
  // and it must not read as one on the wire.
  const set = (patch: Partial<DirectoryFilters>) => {
    const merged: Record<string, unknown> = { ...filters, ...patch };
    const next = Object.fromEntries(
      Object.entries(merged).filter(
        ([, value]) =>
          value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
      )
    );
    onChange(next as DirectoryFilters);
  };

  const toggleCapability = (capability: string) => {
    const held = filters.capabilities ?? [];
    set({
      capabilities: held.includes(capability)
        ? held.filter((candidate) => candidate !== capability)
        : [...held, capability],
    });
  };

  const active = Object.keys(filters).length > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Directory filters"
    >
      <Select
        label="Isolation"
        value={filters.isolation ?? ''}
        options={ISOLATIONS}
        disabled={disabled}
        onChange={(isolation) => set({ isolation })}
      />
      <Select
        label="Arch"
        value={filters.arch ?? ''}
        options={ARCHITECTURES}
        disabled={disabled}
        onChange={(arch) => set({ arch })}
      />
      <Select
        label="GPU"
        value={filters.gpu ?? ''}
        options={gpus}
        disabled={disabled}
        onChange={(gpu) => set({ gpu })}
      />
      <Select
        label="Hidden"
        value={filters.hidden === undefined ? '' : String(filters.hidden)}
        options={HIDDEN}
        disabled={disabled}
        onChange={(value) => set({ hidden: value === '' ? undefined : value === 'true' })}
      />

      <fieldset className="flex items-center gap-2 rounded-md border px-2 py-1">
        <legend className="sr-only">Capabilities</legend>
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Grants</span>
        {CAPABILITIES.map((capability) => (
          <label key={capability} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={(filters.capabilities ?? []).includes(capability)}
              disabled={disabled}
              onChange={() => toggleCapability(capability)}
            />
            <code className="font-mono">{capability}</code>
          </label>
        ))}
      </fieldset>

      {active && (
        <>
          <Button size="sm" variant="ghost" onClick={() => onChange({})} disabled={disabled}>
            Clear
          </Button>
          <Badge variant="secondary">{Object.keys(filters).length} filtered</Badge>
        </>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
      <span className="text-muted-foreground uppercase tracking-wide">{label}</span>
      <select
        aria-label={label}
        className="bg-transparent text-xs outline-none"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
