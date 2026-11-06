FROM denoland/deno:2.9.6

WORKDIR /app

# Dependencies first, so code changes reuse this layer. Pyodide lands in node_modules.
COPY deno.json deno.lock ./
RUN deno install --frozen

COPY src ./src
RUN deno cache src/main.ts

# The files stay owned by root: the service and its sandboxes can read them, never change them.
USER deno

CMD ["deno", "task", "start"]
