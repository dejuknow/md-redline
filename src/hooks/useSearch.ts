import { useState, useCallback } from 'react';

export function useSearch(onClose: () => void) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0);

  const handleSearchCount = useCallback((count: number) => {
    setSearchMatchCount(count);
    setActiveSearchIndex((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
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
    setActiveSearchIndex((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
  }, []);

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
