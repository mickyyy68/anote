import {
  Alert,
  Action,
  ActionPanel,
  Clipboard,
  Form,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { openAnoteApp } from "./lib/anote-app";
import { BridgeError, bridgeErrorMessage, deleteNoteViaBridge, updateNoteViaBridge } from "./lib/bridge";
import { getReadonlyNoteById, searchNotesReadOnly } from "./lib/db";
import type { ReadonlyNote, ReadonlyNoteSummary } from "./lib/types";

type UpdateFormValues = {
  title: string;
  body: string;
};

function formatUpdatedAt(ts: number): string {
  if (!ts) return "Unknown";
  return new Date(ts).toLocaleString();
}

function detailMarkdown(item: ReadonlyNoteSummary, note: ReadonlyNote | null): string {
  const title = (note?.title || item.title || "Untitled").replace(/^#+\s*/g, "");
  const body = note?.body ?? item.preview;
  return `# ${title}\n\n${body || "_Empty note_"}`;
}

function UpdateNoteForm(props: {
  noteId: string;
  onUpdated: () => Promise<void>;
}) {
  const { noteId, onUpdated } = props;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<number | undefined>();

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      setIsLoading(true);
      try {
        const note = await getReadonlyNoteById(noteId);
        if (!note || disposed) return;
        setTitle(note.title || "");
        setBody(note.body || "");
        setLoadedUpdatedAt(note.updatedAt);
      } catch (error) {
        if (!disposed) {
          await showToast({
            style: Toast.Style.Failure,
            title: "Failed to load note",
            message: String(error),
          });
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };
    run();
    return () => {
      disposed = true;
    };
  }, [noteId]);

  async function submit(values: UpdateFormValues) {
    setIsSaving(true);
    try {
      await updateNoteViaBridge({
        id: noteId,
        title: values.title,
        body: values.body,
        updatedAt: loadedUpdatedAt,
      });
      await showToast({ style: Toast.Style.Success, title: "Note updated" });
      await onUpdated();
      await popToRoot();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to update note",
        message: bridgeErrorMessage(error),
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Form
      navigationTitle="Update Note"
      isLoading={isLoading || isSaving}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Changes" icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" value={title} onChange={setTitle} />
      <Form.TextArea id="body" title="Body" value={body} onChange={setBody} />
    </Form>
  );
}

export default function SearchNotesCommand() {
  const [searchText, setSearchText] = useState("");
  const [items, setItems] = useState<ReadonlyNoteSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedNote, setSelectedNote] = useState<ReadonlyNote | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    let disposed = false;
    // Small debounce to avoid running sqlite queries on every keystroke.
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const next = await searchNotesReadOnly(searchText, 80);
        if (disposed) return;
        setItems(next);
        setSelectedId((prev) => {
          if (prev && next.some((item) => item.id === prev)) return prev;
          return next[0]?.id;
        });
      } catch (error) {
        if (!disposed) {
          setItems([]);
          await showToast({
            style: Toast.Style.Failure,
            title: "Failed to search notes",
            message: String(error),
          });
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    }, 120);

    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [searchText, reloadSeq]);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      if (!selectedId) {
        setSelectedNote(null);
        return;
      }
      try {
        // Load full body lazily to keep list search snappy.
        const note = await getReadonlyNoteById(selectedId);
        if (!disposed) setSelectedNote(note);
      } catch {
        if (!disposed) setSelectedNote(null);
      }
    };
    run();
    return () => {
      disposed = true;
    };
  }, [selectedId, reloadSeq]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  async function copyNoteContent(item: ReadonlyNoteSummary) {
    try {
      const note = await getReadonlyNoteById(item.id);
      const content = note?.body ?? item.preview;
      await Clipboard.copy(content);
      await showToast({ style: Toast.Style.Success, title: "Note content copied" });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to copy note",
        message: String(error),
      });
    }
  }

  async function launchAnote() {
    try {
      await openAnoteApp();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to open anote",
        message: String(error),
      });
    }
  }

  async function reloadData() {
    // Bump sequence to force both list and selected-note detail reload.
    setReloadSeq((value) => value + 1);
  }

  async function deleteNote(item: ReadonlyNoteSummary) {
    const confirmed = await confirmAlert({
      title: "Delete this note?",
      message: "This permanently deletes the note and cannot be undone.",
      primaryAction: {
        title: "Delete",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;

    try {
      const loadedUpdatedAt = selectedNote?.id === item.id ? selectedNote.updatedAt : undefined;
      await deleteNoteViaBridge({
        id: item.id,
        updatedAt: loadedUpdatedAt ?? item.updatedAt,
      });
      await showToast({ style: Toast.Style.Success, title: "Note deleted" });
      await reloadData();
    } catch (error) {
      let message = bridgeErrorMessage(error);
      if (error instanceof BridgeError) {
        if (error.code === "CONFLICT") {
          message = "Note changed elsewhere; refresh and try again.";
        } else if (error.code === "VALIDATION") {
          message = "Note no longer exists or request is invalid.";
        }
      }
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to delete note",
        message,
      });
    }
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder="Search anote notes..."
      onSearchTextChange={setSearchText}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
      throttle
    >
      {items.length === 0 ? (
        <List.EmptyView title="No notes found" description="Try another query or create a new note." />
      ) : (
        items.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title || "Untitled"}
            subtitle={item.folderName || "No folder"}
            accessories={[{ text: formatUpdatedAt(item.updatedAt) }]}
            detail={
              <List.Item.Detail
                markdown={detailMarkdown(item, selectedItem?.id === item.id ? selectedNote : null)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Folder" text={item.folderName || "No folder"} />
                    <List.Item.Detail.Metadata.Label title="Updated" text={formatUpdatedAt(item.updatedAt)} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="Copy Note Content"
                  icon={Icon.Clipboard}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                  onAction={() => copyNoteContent(item)}
                />
                <Action.CopyToClipboard title="Copy Note Title" content={item.title || ""} />
                <Action.Push
                  title="Update Note"
                  icon={Icon.Pencil}
                  target={<UpdateNoteForm noteId={item.id} onUpdated={reloadData} />}
                />
                <Action
                  title="Delete Note"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => deleteNote(item)}
                />
                <Action title="Open anote" icon={Icon.AppWindow} onAction={launchAnote} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
