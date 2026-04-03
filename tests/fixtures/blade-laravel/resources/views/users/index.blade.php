@extends('layouts.app')

@section('title', 'Users')

@section('content')
    <h1>Users</h1>
    @foreach($users as $user)
        <x-user-card :user="$user" />
    @endforeach
@endsection
