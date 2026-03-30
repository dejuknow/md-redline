import { useState, useCallback, useEffect } from 'react';

export function useSearch(onClose: () => void, viewMode: string) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0);

  const handleSearchCount = useCallback((count: number) => {
    setSearchMatchCount(count);
  }, []);

  const handleSearchNext = useCallback(() => {
    setActiveSearchIndex((prev) => (prev < searchMatchCount - 1 ? prev + 1 : 0));
  }, [searchMatchCount]);

  const handleSearchPrev = useCallback(() => {
    setActiveSearchIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, searchMatchCount - 1)));
  }, [searchMatchCount]);

  const handleSearchClose = useCallback(() => {
    onClose();
    setSearchQuery('');
    setActiveSearchIndex(0);
    setSearchMatchCount(0);
  }, [onClose]);

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setActiveSearchIndex(0);
  }, []);

  const handleRawSearchCount = useCallback((count: number) => {
    setSearchMatchCount(count);
  }, []);

  // Reset match count in diff view (no search support)
  useEffect(() => {
    if (viewMode === 'diff') setSearchMatchCount(0);
  }, [viewMode]);

  return {
    searchQuery,
    activeSearchIndex,
    searchMatchCount,
    searchFocusTrigger,
    setSearchFocusTrigger,
    handleSearchCount,
    handleSearchNext,
    handleSearchPrev,
    handleSearchClose,
    handleSearchQueryChange,
    handleRawSearchCount,
  };
}
