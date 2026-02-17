export type ReadonlyNoteSummary = {
  id: string;
  folderId: string;
  folderName: string;
  title: string;
  preview: string;
  updatedAt: number;
};

export type ReadonlyNote = {
  id: string;
  folderId: string;
  folderName: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  pinned: number;
  sortOrder: number;
};

export type CreateNoteRequest = {
  title: string;
  body: string;
  folderId?: string;
};

export type CreateNoteResponse = {
  id: string;
  folderId: string;
  createdAt: number;
  updatedAt: number;
};

export type UpdateNoteRequest = {
  id: string;
  title: string;
  body: string;
  updatedAt?: number;
};
