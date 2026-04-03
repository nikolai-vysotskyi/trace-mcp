<div>
    @livewire('search-bar')

    <ul>
        @foreach ($orders as $order)
            <li wire:click="refreshList({{ $order->id }})">{{ $order->id }}</li>
        @endforeach
    </ul>
</div>
