import { Action, ActionPanel, Form, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { bridgeErrorMessage, createNoteViaBridge } from "./lib/bridge";

type VoiceNoteFormValues = {
  title: string;
  body: string;
};

export default function VoiceNoteCommand() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function submit(values: VoiceNoteFormValues) {
    if (!values.body.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No note content",
        message: "Please record voice or type content",
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
        title: "Voice note created",
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
      navigationTitle="Voice Note"
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Voice Note" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Create a note using voice input. Click the microphone icon in the text area to record." />
      <Form.TextField id="title" title="Title (Optional)" value={title} onChange={setTitle} placeholder="Note title" />
      <Form.TextArea
        id="body"
        title="Content"
        value={body}
        onChange={setBody}
        placeholder="Click the microphone icon to record voice..."
      />
    </Form>
  );
}
