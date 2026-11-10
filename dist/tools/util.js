/** Tool result carrying JSON the model can read. */
export function ok(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
