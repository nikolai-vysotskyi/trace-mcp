/* Gallery.tsx — every primitive × every size × every state, on one page.

   Open with `?view=gallery` (add `&theme=dark` to force the dark appearance).
   This is the reference surface for the TRA-290 primitives: if a control does
   not appear here it is not a primitive, and if it appears here it is bound by
   the geometry checks in __tests__/primitives.test.ts.

   Deliberately not a Storybook — one route, no dependency, no build step. */

import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Badge, type Tone } from './Badge';
import { Button, type ButtonSize } from './Button';
import { Checkbox } from './Checkbox';
import { Chip, ChipGroup } from './Chip';
import { PopUpButton } from './PopUpButton';
import { SearchField } from './SearchField';
import { SegmentedControl } from './SegmentedControl';

const SIZES: ButtonSize[] = ['small', 'regular', 'large'];
const TONES: Tone[] = ['neutral', 'accent', 'green', 'orange', 'red', 'blue', 'purple'];

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 32 }}>
      <span
        style={{
          width: 150,
          flex: 'none',
          fontSize: 11,
          color: 'var(--label-tertiary)',
          cursor: 'default',
        }}
      >
        {title}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 590,
          color: 'var(--label)',
          cursor: 'default',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Gallery(): ReactNode {
  const [seg, setSeg] = useState('table');
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<string[]>(['B']);
  const [single, setSingle] = useState('all');
  const [checked, setChecked] = useState(true);
  const [sort, setSort] = useState('name');

  const toggleChip = (g: string) =>
    setChips((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  return (
    <div
      style={{
        padding: 24,
        overflow: 'auto',
        height: '100%',
        background: 'var(--surface)',
        color: 'var(--label)',
        fontSize: 13,
      }}
    >
      <h1 style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 620, cursor: 'default' }}>
        Lattice control primitives
      </h1>

      <Section title="Button">
        {SIZES.map((size) => (
          <Row key={size} title={`prominent · ${size}`}>
            <Button variant="prominent" size={size}>
              Index project
            </Button>
            <Button variant="prominent" size={size} icon="add">
              With icon
            </Button>
            <Button variant="prominent" size={size} disabled>
              Disabled
            </Button>
          </Row>
        ))}
        {SIZES.map((size) => (
          <Row key={size} title={`bordered · ${size}`}>
            <Button variant="bordered" size={size}>
              Refresh
            </Button>
            <Button variant="bordered" size={size} active>
              Selected
            </Button>
            <Button variant="bordered" size={size} disabled>
              Disabled
            </Button>
          </Row>
        ))}
        {SIZES.map((size) => (
          <Row key={size} title={`plain · ${size}`}>
            <Button variant="plain" size={size}>
              Clear filters
            </Button>
            <Button variant="plain" size={size} active>
              Selected
            </Button>
            <Button variant="plain" size={size} disabled>
              Disabled
            </Button>
          </Row>
        ))}
        {SIZES.map((size) => (
          <Row key={size} title={`icon · ${size}`}>
            <Button variant="icon" size={size} aria-label="Refresh" title="Refresh">
              <Icon name="history" size={16} />
            </Button>
            <Button variant="icon" size={size} active aria-label="Settings" title="Settings">
              <Icon name="settings" size={16} />
            </Button>
            <Button variant="icon" size={size} disabled aria-label="Close" title="Close">
              <Icon name="close" size={16} />
            </Button>
          </Row>
        ))}
      </Section>

      <Section title="SegmentedControl">
        {(['regular', 'large'] as const).map((size) => (
          <Row key={size} title={size}>
            <SegmentedControl
              size={size}
              options={[
                { value: 'table', label: 'Table' },
                { value: 'compact', label: 'Compact' },
                { value: 'cards', label: 'Cards', disabled: true },
              ]}
              value={seg}
              onChange={setSeg}
              aria-label="View mode"
            />
          </Row>
        ))}
      </Section>

      <Section title="SearchField">
        <Row title="idle / filled">
          <SearchField value={query} onChange={setQuery} placeholder="Search projects" />
          <span style={{ width: 240, display: 'flex' }}>
            <SearchField grow value={query} onChange={setQuery} placeholder="Grow to fill" />
          </span>
        </Row>
      </Section>

      <Section title="Chip">
        <Row title="multi-select">
          <ChipGroup label="Grade">
            {['A', 'B', 'C', 'D', 'F'].map((g) => (
              <Chip
                key={g}
                label={g}
                selected={chips.includes(g)}
                onClick={() => toggleChip(g)}
                title={`Tech debt grade ${g}`}
                aria-label={`Tech debt grade ${g}`}
              />
            ))}
          </ChipGroup>
        </Row>
        <Row title="single-select">
          <ChipGroup label="Show">
            {['all', 'errors'].map((v) => (
              <Chip
                key={v}
                single
                label={v === 'all' ? 'All' : 'Errors'}
                selected={single === v}
                onClick={() => setSingle(v)}
                title={v === 'all' ? 'All calls' : 'Failed calls only'}
              />
            ))}
          </ChipGroup>
        </Row>
        <Row title="with icon / disabled">
          <Chip
            label={
              <>
                <Icon name="lock" size={12} /> Security
              </>
            }
            selected={false}
            onClick={() => {}}
            title="Projects with security findings"
          />
          <Chip label="Disabled" selected={false} disabled onClick={() => {}} />
        </Row>
      </Section>

      <Section title="Badge">
        <Row title="all tones">
          {TONES.map((t) => (
            <Badge key={t} tone={t}>
              {t}
            </Badge>
          ))}
        </Row>
        <Row title="grade">
          {['A', 'B', 'C', 'D', 'F'].map((g) => (
            <Badge
              key={g}
              tone={g === 'A' || g === 'B' ? 'green' : g === 'C' ? 'orange' : 'red'}
              aria-label={`Tech debt grade ${g}`}
              title={`Tech debt grade ${g}`}
            >
              {g}
            </Badge>
          ))}
        </Row>
      </Section>

      <Section title="Checkbox">
        <Row title="off / on / mixed / disabled">
          <Checkbox checked={false} onChange={() => {}} aria-label="Unchecked example" />
          <Checkbox checked={checked} onChange={setChecked} aria-label="Checked example" />
          <Checkbox checked={false} indeterminate onChange={() => {}} aria-label="Mixed example" />
          <Checkbox checked disabled onChange={() => {}} aria-label="Disabled example" />
        </Row>
      </Section>

      <Section title="PopUpButton">
        <Row title="inline / block">
          <PopUpButton
            options={[
              { value: 'name', label: 'Name' },
              { value: 'modified', label: 'Date modified' },
              { value: 'size', label: 'Size' },
            ]}
            value={sort}
            onChange={setSort}
            aria-label="Sort files"
          />
          <span style={{ width: 180, display: 'flex' }}>
            <PopUpButton
              block
              options={[
                { value: 'name', label: 'Name' },
                { value: 'modified', label: 'Date modified' },
              ]}
              value={sort}
              onChange={setSort}
              aria-label="Sort files, full width"
            />
          </span>
        </Row>
      </Section>
    </div>
  );
}
