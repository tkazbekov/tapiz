# Tapiz: Your Self-Hosted Collaborative Whiteboard

Tapiz is a **self-hosted**, web-based collaborative board built for teams to run smoother online meetings, brainstorming sessions, and project planning. Whether you're organizing agile workflows, running retrospectives, or brainstorming ideas, Tapiz provides all the tools you need to collaborate in real-time — **on your own infrastructure**.

> **This is a fork.** It is based on [juanfran/tapiz](https://github.com/juanfran/tapiz) and has been modified since October 2026. Changes from upstream include:
>
> - email and password accounts with guest access to boards shared by link (replacing Google sign-in)
> - facilitation tools: a vote budget per user, hiding and revealing all notes, and admin-only board editing
> - LLM board building over MCP: ready-made layouts, server-rendered previews and saved personal or team templates
> - dependency upgrades across the stack
>
> Both projects are licensed under the [GNU AGPL v3](LICENSE.md).

![Tapiz Demo](resources/demo-tapiz-new.webp)

## Key Features

- 📝 **Real-time collaboration**
- 🗒️ **Sticky notes**
- 🎨 **Freehand drawing**
- 📊 **Polling**
- 🔢 **Estimations**
- ✅ **Voting**
- ⚙️ **Self-hosted**
- ➕ And much more

## Live Demo

Try out the upstream project's [live demo](https://tapiz.pages.dev/board/demo) to explore the core features in your browser. It does not include this fork's changes.

For the best experience, including **teams**, **multiple boards** and **real-time collaboration**, consider installing the full app on your own server.

## Why Tapiz?

Unlike other collaborative tools, Tapiz is open source and fully **self-hosted**. This gives you control over your data and deployment, perfect for teams who value privacy and customization.

## Self-Host with Docker

You can get started with Tapiz locally or self-host it using Docker.

[Follow the step-by-step guide](./docs/INSTALL.md) to get started with Docker.

## Built with:

Tapiz is built using the following technologies and libraries:

- [Angular](https://angular.dev/)
- [NgRx](https://ngrx.io/)
- [Fastify](https://www.fastify.io/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [PostgreSQL](https://www.postgresql.org/)
- [TRPC](https://trpc.io/)
- [Nx](https://nx.dev/)
- [Lucide](https://lucide.dev/)
