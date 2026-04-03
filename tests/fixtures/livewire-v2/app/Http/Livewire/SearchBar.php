<?php

namespace App\Http\Livewire;

use Livewire\Component;

class SearchBar extends Component
{
    public $query = '';

    public $results = [];

    public function updatedQuery()
    {
        $this->results = [];
    }

    public function search()
    {
        $this->emit('search-executed', $this->query);
    }

    public function clearSearch()
    {
        $this->query = '';
        $this->emit('search-cleared');
    }

    public function render()
    {
        return view('livewire.search-bar');
    }
}
