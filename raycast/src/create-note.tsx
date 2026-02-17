import { Action, ActionPanel, Form, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { bridgeErrorMessage, createNoteViaBridge } from "./lib/bridge";

type CreateFormValues = {
  title: string;
  body: string;
  folderId?: string;
};

export default function CreateNoteCommand() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [folderId, setFolderId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(values: CreateFormValues) {
    setIsSubmitting(true);
    try {
      const result = await createNoteViaBridge({
        title: values.title || "",
        body: values.body || "",
        // Omitted folder ID instructs bridge to ensure/use the dedicated Inbox folder.
        folderId: values.folderId?.trim() ? values.folderId.trim() : undefined,
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Note created",
        message: `id: ${result.id}`,
      });

      setTitle("");
      setBody("");
      setFolderId("");
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to create note",
        message: bridgeErrorMessage(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      navigationTitle="Create Note"
      isLoading={isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Note" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Leave Folder ID empty to create in Inbox." />
      <Form.TextField id="title" title="Title" value={title} onChange={setTitle} />
      <Form.TextArea id="body" title="Body" value={body} onChange={setBody} />
      <Form.TextField id="folderId" title="Folder ID (Optional)" value={folderId} onChange={setFolderId} />
    </Form>
  );
}
