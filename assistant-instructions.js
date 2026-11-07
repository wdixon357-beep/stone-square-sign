import { assistantError } from './assistant-actions.js';

// This is a bounded report from Muse under an owner-saved delegation. It is not
// independent proof of the speaker or of a human review of the document.
export function validateAssistantInstruction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['instruction','instructionReference'].includes(key))
      || typeof input.instruction !== 'string' || !input.instruction.trim()
      || input.instruction.length > 2000
      || (input.instructionReference !== undefined && input.instructionReference !== null
        && (typeof input.instructionReference !== 'string' || !input.instructionReference.trim()
          || input.instructionReference.length > 300))) {
    throw assistantError(400, 'Provide the specific instruction in at most 2000 characters and an optional reference in at most 300 characters.');
  }
  return {instruction:input.instruction.trim(), instructionReference:input.instructionReference?.trim() || null};
}
