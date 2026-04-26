import { useState, useCallback, type Dispatch, type SetStateAction } from 'react';

export type ModalId =
  | 'commandPalette'
  | 'fileOpener'
  | 'settings'
  | 'shortcuts'
  | 'search'
  | 'mermaidFullscreen'
  | null;

export function useModalState(): {
  activeModal: ModalId;
  setActiveModal: Dispatch<SetStateAction<ModalId>>;
  toggleModal: (id: ModalId) => void;
  openFilePicker: () => void;
} {
  const [activeModal, setActiveModal] = useState<ModalId>(null);

  const toggleModal = useCallback((id: ModalId) => {
    setActiveModal((prev) => (prev === id ? null : id));
  }, []);

  const openFilePicker = useCallback(() => {
    setActiveModal('fileOpener');
  }, []);

  return { activeModal, setActiveModal, toggleModal, openFilePicker };
}
