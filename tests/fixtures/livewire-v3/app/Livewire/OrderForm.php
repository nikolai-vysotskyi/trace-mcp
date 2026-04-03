<?php

namespace App\Livewire;

use Livewire\Component;
use Livewire\Attributes\On;
use App\Models\Order;
use App\Livewire\Forms\OrderFormData;

class OrderForm extends Component
{
    public OrderFormData $form;

    public Order $order;

    public function submit(): void
    {
        $this->form->validate();
        $this->dispatch('order-created', orderId: $this->order->id);
    }

    public function cancel(): void
    {
        $this->dispatch('order-cancelled');
    }

    #[On('cart-updated')]
    public function refreshCart(): void
    {
        // refresh logic
    }

    public function render()
    {
        return view('livewire.order-form');
    }
}
