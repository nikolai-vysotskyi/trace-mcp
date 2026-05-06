import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';

interface User {
  id: string;
  name: string;
  email: string;
}

const columnHelper = createColumnHelper<User>();

export const userColumns = [
  columnHelper.accessor('name', { header: 'Name' }),
  columnHelper.accessor('email', { header: 'Email' }),
  columnHelper.accessor((row) => row.id, { id: 'id', header: 'ID' }),
];

export function UsersGrid({ data }: { data: User[] }) {
  const table = useReactTable({
    data,
    columns: userColumns,
    state: { sorting: [], pagination: { pageIndex: 0, pageSize: 10 } },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return null as unknown as JSX.Element;
}
