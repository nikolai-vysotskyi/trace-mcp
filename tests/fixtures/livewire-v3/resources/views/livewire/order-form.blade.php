<div>
    <form wire:submit="submit">
        <input wire:model="form.notes" type="text" />
        <input wire:model="form.total" type="number" />
        <button type="submit">Place Order</button>
        <button type="button" wire:click="cancel">Cancel</button>
    </form>

    <livewire:order-summary :orderId="$order->id" />
</div>
