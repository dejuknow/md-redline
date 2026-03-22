import { useState, useCallback } from 'react';

export function useFile() {
  const [filePath, setFilePath] = useState('');
  const [rawMarkdown, setRawMarkdown] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  const loadFile = useCallback(async (path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFilePath(data.path);
      setRawMarkdown(data.content);
      setLastSaved(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveFile = useCallback(
    async (content: string) => {
      if (!filePath) return;
      try {
        const res = await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setLastSaved(new Date());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save file');
      }
    },
    [filePath],
  );

  const reloadFile = useCallback(async () => {
    if (filePath) await loadFile(filePath);
  }, [filePath, loadFile]);

  const closeFile = useCallback(() => {
    setFilePath('');
    setRawMarkdown('');
    setLastSaved(null);
    setError(null);
  }, []);

  return {
    filePath,
    rawMarkdown,
    setRawMarkdown,
    isLoading,
    error,
    lastSaved,
    loadFile,
    saveFile,
    reloadFile,
    closeFile,
  };
}
