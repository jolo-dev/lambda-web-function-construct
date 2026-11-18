<script setup lang="ts">
const renderedAt = new Date().toISOString()
const count = ref(0)
</script>

<template>
  <main>
    <h1>Nuxt on Lambda Web Function</h1>
    <p id="ssr-time">Rendered on the server at {{ renderedAt }}</p>
    <p>
      <a id="about-link" href="/about">About</a>
    </p>
    <section>
      <h2>Client counter</h2>
      <p id="count">Count: {{ count }}</p>
      <button id="increment" type="button" @click="count++">Increment</button>
    </section>
    <SquareForm />
  </main>
</template>
