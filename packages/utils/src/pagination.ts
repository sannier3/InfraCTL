export type Pagination = {
  page: number;
  limit: number;
  total: number;
  pages: number;
};

export function paginate<T>(items: readonly T[], page: number, limit: number): { data: T[]; pagination: Pagination } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * limit;
  return {
    data: items.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      pages,
    },
  };
}

export function paginationMeta(total: number, page: number, limit: number): Pagination {
  const pages = total === 0 ? 1 : Math.ceil(total / limit);
  return { page, limit, total, pages };
}
