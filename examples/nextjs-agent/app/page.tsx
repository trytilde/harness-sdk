"use client";

import { useChat } from "@ai-sdk/react";

export default function Home() {
  const { messages, sendMessage, status } = useChat();

  return (
    <main>
      <section>
        <div>
          {messages.map((message) => (
            <article key={message.id} data-role={message.role}>
              <strong>{message.role}</strong>
              {message.parts.map((part) =>
                part.type === "text" ? (
                  <p key={`${message.id}-${part.text}`}>{part.text}</p>
                ) : null,
              )}
            </article>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const text = String(data.get("message") || "");
            if (text.trim()) {
              sendMessage({ text });
              form.reset();
            }
          }}
        >
          <input name="message" placeholder="Ask your Tilde agent" />
          <button type="submit" disabled={status !== "ready"}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
