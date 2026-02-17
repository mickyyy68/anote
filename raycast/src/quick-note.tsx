import { Action, ActionPanel, Clipboard, Form, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { bridgeErrorMessage, createNoteViaBridge } from "./lib/bridge";

type QuickNoteFormValues = {
  title: string;
  body: string;
};

export default function QuickNoteCommand() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function pasteFromClipboard() {
    try {
      const clipboardContent = await Clipboard.readText();
      if (clipboardContent) {
        setBody(clipboardContent);
      } else {
        await showToast({
          style: Toast.Style.Animated,
          title: "Clipboard is empty",
        });
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to read clipboard",
        message: String(error),
      });
    }
  }

  async function submit(values: QuickNoteFormValues) {
    if (!values.body.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No note content",
        message: "Please enter or paste content",
      });
      return;
    }

    setIsLoading(true);
    try {
      const result = await createNoteViaBridge({
        title: values.title?.trim() || "",
        body: values.body.trim(),
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Quick note created",
        message: `id: ${result.id}`,
      });

      setTitle("");
      setBody("");
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to create note",
        message: bridgeErrorMessage(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      navigationTitle="Quick Note"
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Note" onSubmit={submit} />
          <Action title="Paste from Clipboard" onAction={pasteFromClipboard} />
        </ActionPanel>
      }
    >
      <Form.Description text="Quickly create a note. Leave title empty for untitled." />
      <Form.TextField id="title" title="Title (Optional)" value={title} onChange={setTitle} placeholder="Note title" />
      <Form.TextArea
        id="body"
        title="Content"
        value={body}
        onChange={setBody}
        placeholder="Write your note here... or click 'Paste from Clipboard'"
      />
    </Form>
  );
}
