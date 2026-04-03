<?php

namespace App\Http\Livewire;

use Livewire\Component;
use App\Models\Order;

class OrderList extends Component
{
    public $orders = [];

    protected $listeners = [
        'order-created' => 'refreshList',
        'orderCancelled' => 'handleCancel',
    ];

    public function mount()
    {
        $this->orders = Order::latest()->get();
    }

    public function refreshList($orderId = null)
    {
        $this->orders = Order::latest()->get();
    }

    public function handleCancel()
    {
        $this->orders = Order::latest()->get();
    }

    public function render()
    {
        return view('livewire.order-list');
    }
}
