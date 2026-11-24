import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Badge, EmptyState, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { ConfirmProvider, Dialog, useConfirm } from '@/components/ui/overlay';

describe('Button', () => {
  it('shows a spinner and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b).toBeDisabled();
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Field', () => {
  it('renders the label, required marker and an accessible error', () => {
    render(<Field label="Email" required error="Enter a valid email" htmlFor="e"><Input id="e" invalid /></Field>);
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email');
  });
});

interface Row { id: string; name: string; status: string }
const columns: Column<Row>[] = [{ key: 'name', header: 'Name', primary: true, cell: (r) => r.name }, { key: 'status', header: 'Status', cell: (r) => <Badge>{r.status}</Badge> }];

describe('DataTable', () => {
  const rows: Row[] = [{ id: '1', name: 'Ada', status: 'New' }, { id: '2', name: 'Grace', status: 'Won' }];
  it('renders rows, supports row click and selection (select all)', async () => {
    const onRow = vi.fn(); const onSel = vi.fn();
    render(<DataTable columns={columns} rows={rows} onRowClick={onRow} selection={{ selected: new Set(), onChange: onSel, renderCheckbox: (c, ch, label, ind) => <Checkbox checked={c} onCheckedChange={ch} aria-label={label} indeterminate={ind} /> }} />);
    expect(screen.getAllByText('Ada').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    expect(onSel).toHaveBeenCalledWith(new Set(['1', '2']));
    await userEvent.click(screen.getAllByText('Grace')[0]!);
    expect(onRow).toHaveBeenCalledWith(rows[1]);
  });
  it('shows skeletons while loading and the empty state when there is no data', () => {
    const { rerender, container } = render(<DataTable columns={columns} rows={undefined} loading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    rerender(<DataTable columns={columns} rows={[]} empty={<EmptyState title="No leads yet" />} />);
    expect(screen.getByText('No leads yet')).toBeInTheDocument();
  });
  it('is sortable from column headers', async () => {
    const onSort = vi.fn();
    render(<DataTable columns={[{ ...columns[0]!, sortable: true }, columns[1]!]} rows={rows} onSort={onSort} sort={{ key: 'name', order: 'asc' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledWith('name');
  });
});

describe('Pagination', () => {
  it('reports the visible range and navigates', async () => {
    const onPage = vi.fn();
    render(<Pagination page={2} pageSize={25} total={60} onPage={onPage} noun="leads" />);
    expect(screen.getByText(/26–50 of 60 leads/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPage).toHaveBeenCalledWith(1);
  });
});

function Harness() {
  const [open, setOpen] = React.useState(true);
  const confirm = useConfirm();
  void confirm;
  return open ? <Dialog open onOpenChange={setOpen} title="Edit lead" dirty>Body</Dialog> : <p>closed</p>;
}
describe('Dialog unsaved-changes guard', () => {
  it('asks for confirmation before discarding a dirty form, and can be cancelled', async () => {
    render(<ConfirmProvider><Harness /></ConfirmProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Edit lead' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByText('closed')).toBeInTheDocument();
  });
});
