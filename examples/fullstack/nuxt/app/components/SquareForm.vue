<script setup lang="ts">
const value = ref('')
const result = ref<string | null>(null)
const error = ref<string | null>(null)

async function submit() {
  result.value = null
  error.value = null
  try {
    const response = await $fetch<{ result?: string; error?: string }>('/api/square', {
      method: 'POST',
      body: { value: value.value },
    })
    if (response?.result) result.value = response.result
    else error.value = response?.error ?? 'Request failed'
  } catch (err: any) {
    const data = err?.data ?? err?.response?._data
    error.value = data?.error ?? 'Request failed'
  }
}
</script>

<template>
  <section>
    <h2>Server mutation</h2>
    <form id="square-form" @submit.prevent="submit">
      <label for="value">Number</label>
      <input id="value" v-model="value" name="value" />
      <button id="square-submit" type="submit">Square</button>
    </form>
    <p v-if="result" id="square-result">{{ result }}</p>
    <p v-if="error" id="square-error">{{ error }}</p>
  </section>
</template>
